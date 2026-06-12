// Single source of truth for parsing a YouTube URL into the three shapes
// the channel-context resolver and the fetch-metadata service can act on.
//
// Distinct from `services/url-parser.ts` (which classifies a paste URL by
// platform — youtube vs twitter vs reddit). This module is YouTube-only
// and decomposes a youtube.com / youtu.be URL into:
//
//   - {kind: "channelId"} — direct /channel/UC… (no resolve needed; we
//                           already have the canonical id).
//   - {kind: "handle"}    — /@handle, /c/legacy, /user/legacy. Resolves
//                           via channels.list?forHandle (1 quota unit).
//   - {kind: "videoId"}   — /watch?v=…, /shorts/…, /embed/…, youtu.be/….
//                           Resolves via videos.list?part=snippet to get
//                           the snippet.channelId (1 quota unit). User-
//                           friendly so pasting any YouTube URL into
//                           /sources/new just works.
//
// Returns null only for non-YouTube hosts or unparseable strings.
//
// This module replaces two near-identical implementations
// (`parseHandleUrl` in
// $lib/sources/youtube/server/handlers/channel-context-backfill.ts and
// `parseYoutubeChannelUrl` in $lib/sources/youtube/server/metadata.ts).
// Both had the same logic; keeping two copies risked drift on every new
// URL shape (e.g. /live/ if YouTube ever ships it). One module, one truth.
//
// `youtubeParseUrl(input)` returns the generic `ParsedUrl` shape consumed
// by the cross-source `parseAnyUrl` iterator (first-match-wins). Distinct
// from `parseYoutubeUrl` above (channelId / handle / videoId discriminator
// for the channel-context backfill worker): `youtubeParseUrl` returns
// ONLY for standalone watchable items (videos / shorts / embed /
// youtu.be) — channels and handles return null because the events table
// only ingests `kind=youtube_video` rows.

import type { ParsedUrl } from "$lib/sources/adapter.js";

export type ParsedYoutubeUrl =
  | { kind: "channelId"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "videoId"; value: string };

export function parseYoutubeUrl(url: string): ParsedYoutubeUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  // youtu.be/ID — short share URL, video.
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "").split("/")[0];
    return id ? { kind: "videoId", value: id } : null;
  }

  if (!/(^|\.)youtube\.com$/i.test(host)) return null;

  // /watch?v=ID — full watch URL, video.
  if (parsed.pathname === "/watch") {
    const v = parsed.searchParams.get("v");
    return v ? { kind: "videoId", value: v } : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0];
  if (!first) return null;

  // /shorts/ID and /embed/ID — also videos.
  if ((first === "shorts" || first === "embed") && segments[1]) {
    return { kind: "videoId", value: segments[1] };
  }

  // /channel/UCxxxxx — direct channelId.
  if (first === "channel" && segments[1]) {
    return { kind: "channelId", value: segments[1] };
  }

  // /@handle — modern handle URL.
  if (first.startsWith("@")) {
    return { kind: "handle", value: first };
  }

  // /c/customname or /user/legacyname — resolvable via forHandle (YouTube
  // accepts a bare name — no @ — alongside @-prefixed handles).
  if ((first === "c" || first === "user") && segments[1]) {
    return { kind: "handle", value: segments[1] };
  }

  return null;
}

// ---- Adapter contract for parseAnyUrl ----

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

/**
 * Returns `ParsedUrl` for any YouTube URL we recognize as a standalone
 * watchable item (video / short / embed / youtu.be link), null otherwise.
 * Channel and playlist URLs return null because the events table only
 * ingests rows of `kind=youtube_video`.
 *
 * Distinct from `parseYoutubeUrl` above — that one decomposes a URL into
 * the channel-context backfill triple (channelId / handle / videoId) for
 * the backfill worker; this one is the cross-source iterator contract
 * consumed by `parseAnyUrl` (src/lib/sources/url.ts) and the
 * `youtubeAdapter.parseUrl` adapter method.
 *
 * Hostname check FIRST rejects e.g. `https://example.com/?v=abc` which
 * would otherwise round-trip through the URL parser unchanged and leak a
 * non-YouTube URL into the youtube_video kind.
 */
export function youtubeParseUrl(input: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;

  // youtu.be/<videoId>
  if (host === "youtu.be") {
    const videoId = url.pathname.replace(/^\//, "").split("/")[0];
    if (videoId == null || videoId === "") return null;
    return makeParsed(videoId, input);
  }

  // youtube.com /watch?v=<videoId>
  if (url.pathname === "/watch") {
    const v = url.searchParams.get("v");
    if (v == null || v === "") return null;
    return makeParsed(v, input);
  }

  // youtube.com /shorts/<videoId>
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shortsMatch && shortsMatch[1] != null) {
    return makeParsed(shortsMatch[1], input);
  }

  // youtube.com /embed/<videoId>
  const embedMatch = url.pathname.match(/^\/embed\/([\w-]+)/);
  if (embedMatch && embedMatch[1] != null) {
    return makeParsed(embedMatch[1], input);
  }

  // youtube.com /live/<videoId> — live streams have a video id like watch.
  const liveMatch = url.pathname.match(/^\/live\/([\w-]+)/);
  if (liveMatch && liveMatch[1] != null) {
    return makeParsed(liveMatch[1], input);
  }

  // /channel/, /@handle, /c/, /user/, /feed/, /playlist — these are not
  // standalone watchable events. Return null; cross-source parseAnyUrl
  // falls through to the next adapter (or to "unsupported").
  return null;
}

function makeParsed(videoId: string, originalInput: string): ParsedUrl {
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    kind: "youtube_video",
    externalId: videoId,
    metadata: { canonicalUrl: canonical, originalUrl: originalInput },
  };
}

/**
 * Is this a youtube.com/shorts/<id> URL? A /shorts/ paste IS the answer — the
 * media type is intrinsic to the path, so the paste flow can persist
 * media_type='short' with NO redirect probe (the canonicalizer collapses
 * /shorts/<id> → /watch?v=<id>, erasing the signal, so we read it off the raw
 * input here BEFORE canonicalization). Returns false for /watch, youtu.be,
 * /embed, /live, and non-YouTube hosts (those carry no Short signal — the poll
 * worker's probe decides them later).
 */
export function isYoutubeShortsUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return false;
  return /^\/shorts\/[\w-]+/.test(url.pathname);
}

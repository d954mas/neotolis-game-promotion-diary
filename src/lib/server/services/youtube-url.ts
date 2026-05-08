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
// Phase 3.0 post-build review (2026-05-07): this module replaces two
// near-identical implementations (`parseHandleUrl` in
// worker/handlers/youtube-channel-context-backfill.ts and
// `parseYoutubeChannelUrl` in services/youtube-metadata.ts). Both had
// the same logic; keeping two copies risked drift on every new URL
// shape (e.g. /live/ if YouTube ever ships it). One module, one truth.

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

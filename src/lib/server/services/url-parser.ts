// URL ingest parser — orchestrator wrapper around the cross-source
// `parseAnyUrl` registry iterator + the `detectFutureKind` Reddit-deferral
// helper.
//
// This module is the FIRST step in the validate-first ingest pipeline.
// It performs zero I/O and zero DB writes — just URL parsing, host
// classification, and canonicalization. The orchestrator
// (`services/ingest.ts`) calls oEmbed integrations AFTER this returns a
// non-`unsupported` kind, then INSERTs ONLY after oEmbed succeeds.
//
// Internally:
//
//   1. `parseAnyUrl(input)` (src/lib/sources/url.ts) — iterates the
//      adapter registry first-match-wins. YouTube is registered, so
//      `youtube.com` / `youtu.be` URLs route through
//      `youtubeAdapter.parseUrl`. Returns `{ kind: "youtube_video",
//      externalId, metadata }` on hit, `{ kind: "unsupported" }`
//      otherwise.
//
//   2. Twitter (`twitter.com` / `x.com` / `mobile.twitter.com`) and
//      Telegram (`t.me`) URL handling stays at the orchestrator layer
//      ("parser of last resort" for kinds without an adapter yet). When
//      Twitter / Telegram adapters land in later phases, those host
//      branches move INSIDE the adapter and this file shrinks
//      correspondingly.
//
//   3. `detectFutureKind(input)` (src/lib/sources/future-kinds.ts)
//      maps remaining DEFERRED-ADAPTER hosts (currently none — Reddit
//      moved to the registry in Phase 03.1, Twitter/Telegram have their
//      own host branches above) to friendly `{ kind: "<x>_deferred" }`
//      shapes. The future-kinds map is currently empty; this branch
//      stays as the seam for future deferred adapters.
//
// Reddit-specific: parseAnyUrl now returns kind='reddit_post' for
// reddit URLs (Phase 03.1 D-RDT-INGEST-REPLACE). Step 1 below maps
// kind='reddit_post' → `{ kind: "reddit_deferred" }` so services/ingest.ts
// keeps the friendly "reddit_not_yet_supported" 422 banner across the
// Plan 07 ↔ Plan 09 gap. Plan 09 will widen ingest.ts to fully process
// reddit_post (handlePostSingle → events INSERT), at which point this
// transitional mapping flips to the real reddit_post canonicalize path.
//
// x.com is canonicalized to twitter.com because
// publish.twitter.com/oembed only accepts the twitter.com host. The
// canonicalization happens here once so every downstream call (oEmbed,
// DB row, audit metadata) uses the same string. mobile.twitter.com is
// also canonicalized to twitter.com for the same reason.

import { parseAnyUrl } from "$lib/sources/url.js";
import { detectFutureKind } from "$lib/sources/future-kinds.js";

export type ParsedUrl =
  | { kind: "youtube_video"; videoId: string; canonicalUrl: string }
  | { kind: "twitter_post"; canonicalUrl: string }
  | { kind: "telegram_post"; canonicalUrl: string }
  | { kind: "reddit_deferred" }
  | { kind: "unsupported" };

const X_HOSTS = new Set(["twitter.com", "x.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me"]);

// YouTube videoId shape — 11 chars, [A-Za-z0-9_-]. The shared
// `youtubeParseUrl` (src/lib/sources/youtube/server/url.ts) is more
// permissive — it returns ParsedUrl for any non-empty path segment in
// /watch / /shorts / /embed / /live / youtu.be — because the adapter
// contract callers (refresh-content endpoint, future iterators) don't all
// need 11-char strictness.
//
// The PUBLIC `parseIngestUrl` API contract DOES need it:
// `https://www.youtube.com/feed/subscriptions` must classify as
// `unsupported`, and the YouTube oEmbed call downstream would fail in
// confusing ways for non-11-char ids. So we re-validate the
// adapter-supplied externalId at this layer before mapping to the
// legacy ParsedUrl shape.
const YOUTUBE_VIDEO_ID_RE = /^[\w-]{11}$/;

export function parseIngestUrl(input: string): ParsedUrl {
  // 1) Adapter registry first (first-match-wins). YouTube wins on
  //    `youtube.com` / `youtu.be` host matches; Reddit wins on
  //    `reddit.com` / `redd.it` host matches.
  const routed = parseAnyUrl(input);
  if (routed.kind === "youtube_video") {
    if (!YOUTUBE_VIDEO_ID_RE.test(routed.externalId)) {
      // Adapter accepted the URL but the id shape is non-canonical
      // (e.g. a /shorts/3char path). Behave as `unsupported`.
      // Downstream oEmbed call would fail anyway and the user gets the
      // same error path either way.
      return { kind: "unsupported" };
    }
    const meta = (routed.metadata ?? {}) as { canonicalUrl?: unknown };
    const canonicalUrl =
      typeof meta.canonicalUrl === "string"
        ? meta.canonicalUrl
        : `https://www.youtube.com/watch?v=${routed.externalId}`;
    return {
      kind: "youtube_video",
      videoId: routed.externalId,
      canonicalUrl,
    };
  }
  // Phase 03.1: Reddit adapter is registered. parseAnyUrl returns
  // kind='reddit_post' for reddit URLs; we map back to reddit_deferred
  // here as a transitional shape — services/ingest.ts still throws
  // `reddit_not_yet_supported` 422 until Plan 09 wires the full
  // paste-flow (handlePostSingle → events INSERT). The friendly
  // inline-info UX banner stays intact across the Plan 07 ↔ Plan 09
  // gap. Once Plan 09 lands, this branch becomes the load-bearing
  // dispatch for kind='reddit_post' → reddit_post canonicalize.
  if (routed.kind === "reddit_post") {
    return { kind: "reddit_deferred" };
  }

  // 2) Host-classification fallback for kinds without an adapter yet
  //    (Twitter / Telegram).
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: "unsupported" };
  }
  const host = url.hostname.toLowerCase();
  if (X_HOSTS.has(host)) {
    // Canonicalize x.com / mobile.twitter.com → twitter.com so
    // publish.twitter.com/oembed accepts the URL. The canonical form is
    // what gets stored in events.url and audit metadata.
    const canonical =
      host === "x.com" || host === "mobile.twitter.com"
        ? `https://twitter.com${url.pathname}${url.search}`
        : url.toString();
    return { kind: "twitter_post", canonicalUrl: canonical };
  }
  if (TG_HOSTS.has(host)) {
    return { kind: "telegram_post", canonicalUrl: url.toString() };
  }

  // 3) detectFutureKind seam for any remaining DEFERRED-ADAPTER hosts.
  //    Reddit moved to the registry in Phase 03.1 (handled at step 1);
  //    the future-kinds map is currently empty. Kept as the extension
  //    point for future deferred adapters.
  const future = detectFutureKind(input);
  if (future === "reddit_post") return { kind: "reddit_deferred" };

  return { kind: "unsupported" };
}

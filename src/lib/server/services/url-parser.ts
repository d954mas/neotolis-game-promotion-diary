// URL ingest parser — orchestrator wrapper around the cross-source
// `parseAnyUrl` registry iterator + the `detectFutureKind` host-hint
// helper.
//
// First step in the validate-first ingest pipeline. Performs zero I/O
// and zero DB writes — just URL parsing, host classification, and
// canonicalization. Downstream callers fire oEmbed (YouTube) or
// /api/info.json (Reddit) only after this returns a non-`unsupported`
// kind, and INSERT only after the per-kind validation succeeds.
//
// Internally:
//
//   1. `parseAnyUrl(input)` (src/lib/sources/url.ts) iterates the
//      adapter registry first-match-wins. YouTube, Reddit, Instagram,
//      TikTok, and Twitter are registered and route through their own
//      `adapter.parseUrl` (e.g. `reddit.com` / `redd.it` →
//      `{kind: "reddit_post", externalId, metadata: {subreddit}}`;
//      `x.com` / `twitter.com` / `mobile.*` →
//      `{kind: "twitter_post", externalId, metadata: {permalink}}`).
//      `{kind: "unsupported"}` when no adapter matches.
//
//   2. Telegram (`t.me`) URL handling stays at the orchestrator layer
//      ("parser of last resort") because there is no registry parseUrl
//      for the Telegram post canonical here. TikTok vm./vt. SHORT links
//      also stay here (they carry no id in the path). When Telegram
//      lands a post parseUrl, that branch moves INSIDE the adapter and
//      this file shrinks correspondingly.
//
//   3. `detectFutureKind(input)` (src/lib/sources/future-kinds.ts) maps
//      remaining deferred-adapter hosts to friendly
//      `{kind: "<x>_deferred"}` shapes. The future-kinds map is empty
//      today; the branch stays as a seam for future deferred adapters
//      that need an inline banner before their adapter ships.

import { parseAnyUrl } from "$lib/sources/url.js";
import { detectFutureKind } from "$lib/sources/future-kinds.js";

export type ParsedUrl =
  | { kind: "youtube_video"; videoId: string; canonicalUrl: string }
  | {
      kind: "reddit_post";
      externalId: string;
      canonicalUrl: string;
      metadata: Record<string, unknown>;
    }
  // Instagram permalink (`/p/<code>`, `/reel/<code>`). The shortcode is the
  // URL-intrinsic externalId (08-SPIKE `code`); canonicalUrl is the
  // `/p/` | `/reel/` permalink the IG adapter's parseUrl already
  // canonicalized. There is NO single-post preview fetch today, so the
  // paste flow recognizes the kind + URL but the user types the title —
  // see enrichFromUrl's instagram_post branch (no network call).
  | { kind: "instagram_post"; externalId: string; canonicalUrl: string }
  // TikTok video permalink (`/@<handle>/video/<id>`). The aweme id is the
  // URL-intrinsic externalId (10-SPIKE: the id IS the URL slug); canonicalUrl is
  // the `/@handle/video/<id>` permalink the TikTok adapter's parseUrl already
  // canonicalized (query tail stripped). A vm./vt. SHORT link is ALSO recognized
  // here (host branch below) and routed with the RAW short URL as canonicalUrl —
  // the adapter's fetchEventPreviewMetadata resolves the short link to the real
  // video before fetching (the parser is pure / does no I/O, so the one network
  // hop lives in the adapter, mirroring canonicalizeOnCreate's Add-Source path).
  | { kind: "tiktok_post"; externalId: string | null; canonicalUrl: string }
  | { kind: "twitter_post"; canonicalUrl: string }
  | { kind: "telegram_post"; canonicalUrl: string }
  | { kind: "unsupported" };

const TG_HOSTS = new Set(["t.me"]);
// vm./vt. short-link hosts. The pure TikTok parser deliberately rejects these
// (they carry no aweme id in the path); the orchestrator recognizes them here and
// routes to the adapter, which does the ONE redirect hop (resolveTikTokShortLink)
// inside fetchEventPreviewMetadata — the same seam canonicalizeOnCreate uses.
const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);

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
  if (routed.kind === "reddit_post") {
    // Reddit's externalId is the base36 post id (without `t3_` prefix
    // per redditParsePostUrl shape). canonicalUrl is the permalink
    // form when the subreddit is in the path; for redd.it/<id>
    // short-links the subreddit isn't known yet (worker resolves it
    // on first fetch). metadata carries the subreddit hint
    // transitively.
    const externalId = routed.externalId;
    const meta = (routed.metadata ?? {}) as { subreddit?: string | null };
    const subreddit = meta.subreddit ?? null;
    const canonicalUrl =
      subreddit !== null
        ? `https://www.reddit.com/r/${subreddit}/comments/${externalId}/`
        : `https://redd.it/${externalId}`;
    return {
      kind: "reddit_post",
      externalId,
      canonicalUrl,
      metadata: { subreddit },
    };
  }
  if (routed.kind === "instagram_post") {
    // The IG adapter's parseUrl already canonicalized the permalink into
    // metadata.permalink (`https://www.instagram.com/p/<code>/` or
    // `/reel/<code>/`). externalId is the shortcode. No live single-post
    // fetch exists — enrichFromUrl's instagram_post branch returns this
    // kind + URL with an empty title so the user types it manually.
    const meta = (routed.metadata ?? {}) as { permalink?: unknown };
    const canonicalUrl =
      typeof meta.permalink === "string"
        ? meta.permalink
        : `https://www.instagram.com/p/${routed.externalId}/`;
    return {
      kind: "instagram_post",
      externalId: routed.externalId,
      canonicalUrl,
    };
  }
  if (routed.kind === "tiktok_post") {
    // The TikTok adapter's parseUrl already canonicalized the permalink into
    // metadata.permalink (`https://www.tiktok.com/@<handle>/video/<id>` — query
    // tail stripped). externalId is the aweme id (the id IS the URL slug). The
    // live single-video preview exists (enrichFromUrl's tiktok_post branch), but
    // the create boundary re-derives the id from OUR cache by canonical permalink
    // (resolveCachedExternalId — untrusted body, #70), so the parsed id here is
    // the URL-intrinsic fallback only.
    const meta = (routed.metadata ?? {}) as { permalink?: unknown };
    const canonicalUrl =
      typeof meta.permalink === "string"
        ? meta.permalink
        : `https://www.tiktok.com/@_/video/${routed.externalId}`;
    return {
      kind: "tiktok_post",
      externalId: routed.externalId,
      canonicalUrl,
    };
  }
  if (routed.kind === "twitter_post") {
    // The Twitter adapter's parseUrl ALWAYS sets metadata.permalink for a routed
    // twitter_post (`https://x.com/<handle>/status/<id>` — query tail stripped by
    // construction); a bare profile URL returns null (a profile is a SOURCE) and falls
    // through to `unsupported`. So the permalink is present by the adapter contract —
    // trust it (AGENTS.md: no handling for impossible cases).
    const meta = (routed.metadata ?? {}) as { permalink: string };
    return { kind: "twitter_post", canonicalUrl: meta.permalink };
  }

  // 2) Host-classification fallback for kinds without an adapter yet
  //    (Telegram).
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: "unsupported" };
  }
  const host = url.hostname.toLowerCase();
  if (TG_HOSTS.has(host)) {
    return { kind: "telegram_post", canonicalUrl: url.toString() };
  }
  if (TIKTOK_SHORT_HOSTS.has(host)) {
    // A vm./vt. short link — the aweme id is NOT in the path (it carries a share
    // code), so externalId is null at parse time. Route the RAW short URL as the
    // canonicalUrl; enrichFromUrl's tiktok_post branch hands it to the adapter,
    // whose fetchEventPreviewMetadata does the ONE redirect hop
    // (resolveTikTokShortLink) to the real /@handle/video/<id> URL before fetching.
    // Mirrors canonicalizeOnCreate's Add-Source short-link seam (the parser stays
    // pure; the network hop lives in the adapter).
    return { kind: "tiktok_post", externalId: null, canonicalUrl: url.toString() };
  }

  // 3) detectFutureKind seam for any remaining deferred-adapter hosts.
  //    The future-kinds map is currently empty (Reddit moved to the
  //    registry, handled at step 1). Kept as the extension point for
  //    future deferred adapters — the call is a pure read of the empty
  //    map so adding a deferred host means editing one file
  //    (future-kinds.ts) not two.
  void detectFutureKind(input);

  return { kind: "unsupported" };
}

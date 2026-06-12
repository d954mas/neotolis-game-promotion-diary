// Cross-source MEDIA-TYPE feed filter vocabulary — the SINGLE source of truth
// for the Short / Video / Other axis (user-requested 2026-06-12).
//
// WHY THIS FILE EXISTS
//
// The /feed surface mixes events from every source (YouTube, IG, TikTok,
// Telegram, Reddit, manual). The user wants to filter the feed by the SHAPE of
// the content — short-form vertical clips, long-form video, everything else —
// regardless of which platform it came from. That cuts across two different
// per-event signals:
//   1. The per-post media kind (NormalizedPost["kind"]) stored on the platform
//      cache row (instagram_posts.media_type / tiktok_posts.media_type), for the
//      two PER-POST kinds (instagram_post / tiktok_post).
//   2. A kind-level default for every OTHER EventKind (a youtube_video is a
//      Video; a reddit_post / telegram_post / conference / … is Other).
//
// This module owns BOTH mappings in one place so the server SQL filter, the URL
// state validator, and the UI axis all derive from the same vocabulary — no
// hand-list can drift (this branch already fixed FOUR hand-list bugs of that
// class; see kind-display.ts FEED_KIND_FILTER_KINDS + url-state.ts
// URL_VALID_KINDS). The `satisfies Record<EventKind, …>` on the kind-level
// defaults map is the compile-enforcement: adding a new EventKind FORCES an
// explicit Short/Video/Other/per-post classification decision (the same pattern
// kind-display.ts uses for the per-kind display flags).
//
// CLIENT-SAFE: imports only the `EventKind` + `NormalizedPost["kind"]` TYPE
// unions (erased at runtime). NO server modules, NO env reads — both the SSR
// loader, the Hono route, and the `.svelte` filter UI import from here.

import type { EventKind } from "$lib/sources/adapter.js";
import type { NormalizedPost } from "$lib/sources/social-provider.js";

/** The three user-facing filter categories (user-locked 2026-06-12). */
export type MediaTypeCategory = "short" | "video" | "other";

/** The per-post media kind stored on a platform cache row's `media_type`
 *  column = NormalizedPost["kind"] = "video" | "short" | "image" | "carousel" |
 *  "text". Re-exported as a named alias so the mapping below reads clearly. */
export type PostMediaKind = NormalizedPost["kind"];

/**
 * The ordered list of filter categories — drives the UI axis chip order AND the
 * URL validator's allowed-value set (mirrors the FEED_KIND_FILTER_KINDS ordered
 * binding). Short first (the headline new axis), then Video, then the Other
 * catch-all.
 */
export const MEDIA_FILTER_CATEGORIES = ["short", "video", "other"] as const satisfies readonly [
  MediaTypeCategory,
  ...MediaTypeCategory[],
];

/**
 * Map a per-post media kind (instagram_posts.media_type /
 * tiktok_posts.media_type) → filter category:
 *   - short    ← "short"  (TikTok ALL videos after the remap; IG Reels map to
 *                          "short" in instagram/server/normalize.ts)
 *   - video    ← "video"  (IG plain feed videos)
 *   - other    ← "image" | "carousel" | "text"
 * A per-post kind ALWAYS classifies into exactly one category (total function).
 */
export function postMediaKindToCategory(kind: PostMediaKind): MediaTypeCategory {
  switch (kind) {
    case "short":
      return "short";
    case "video":
      return "video";
    case "image":
    case "carousel":
    case "text":
      return "other";
  }
}

/**
 * Kind-level classification for every EventKind. Two shapes:
 *   - a concrete MediaTypeCategory: the event's media type is fully determined
 *     by its EventKind (no per-post media row needed) — e.g. youtube_video is
 *     always Video; reddit_post / telegram_post / conference / … are Other.
 *   - the sentinel "per-post": the media type lives on a platform cache row
 *     (instagram_posts / tiktok_posts media_type), so the server filter must
 *     consult that row via postMediaKindToCategory (and treat a MISSING row as
 *     "other" so no event silently vanishes from all three categories).
 *
 * `satisfies Record<EventKind, …>` is the compile guard: a new EventKind MUST
 * declare its classification here, or `pnpm typecheck` fails. youtube_video →
 * video (YouTube Shorts detection is a separate backlog item — NOT attempted).
 */
export const EVENT_KIND_MEDIA_CATEGORY = {
  // Per-post kinds — media type lives on the platform cache row.
  instagram_post: "per-post",
  tiktok_post: "per-post",
  // Kind-level defaults.
  youtube_video: "video", // YouTube Shorts detection is deferred (backlog).
  reddit_post: "other",
  telegram_post: "other",
  twitter_post: "other",
  discord_drop: "other",
  conference: "other",
  talk: "other",
  press: "other",
  other: "other",
  post: "other",
} as const satisfies Record<EventKind, MediaTypeCategory | "per-post">;

/** The EventKinds whose media type is resolved per-post (consult the cache
 *  row). Derived FROM the map so it can never drift — the server filter uses
 *  this to decide which kinds need an EXISTS subquery against the cache table. */
export const PER_POST_MEDIA_KINDS: ReadonlySet<EventKind> = new Set(
  (Object.keys(EVENT_KIND_MEDIA_CATEGORY) as EventKind[]).filter(
    (k) => EVENT_KIND_MEDIA_CATEGORY[k] === "per-post",
  ),
);

/**
 * The EventKinds whose kind-level default IS the given category (i.e. the kinds
 * that classify into `category` WITHOUT consulting a per-post media row).
 * Derived from the map. The server filter ORs an `events.kind IN (these)` clause
 * for the selected category. Per-post kinds are NEVER in this set — they need
 * the cache-row subquery instead.
 */
export function kindLevelKindsForCategory(category: MediaTypeCategory): EventKind[] {
  return (Object.keys(EVENT_KIND_MEDIA_CATEGORY) as EventKind[]).filter(
    (k) => EVENT_KIND_MEDIA_CATEGORY[k] === category,
  );
}

/** Type guard: is a raw string a valid filter category? Used by the URL state
 *  validator (DERIVING from MEDIA_FILTER_CATEGORIES — no hand-list). */
export function isMediaTypeCategory(raw: string): raw is MediaTypeCategory {
  return (MEDIA_FILTER_CATEGORIES as readonly string[]).includes(raw);
}

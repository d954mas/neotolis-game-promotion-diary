// TikTok (ScrapeCreators) provider-shape → NormalizedPost / NormalizedSinglePost
// / ResolvedAccount mapping.
//
// PURE module: no HTTP, no DB. Every field name + nesting below is a
// LIVE-CONFIRMED fact from 10-SPIKE.md (run against `stoolpresidente` /
// `zachking`, 2026-06-10), NOT the documented contract. The net deviations the
// spike caught versus the research/docs are encoded here:
//   1. `max_cursor` is a NUMBER → String(...) for the port's string cursor.
//   2. The videos feed nests FLAT: `aweme_list` / `max_cursor` / `has_more` are
//      all TOP-LEVEL (NOT `data.aweme_list`).
//   3. The feed owner rides on each `aweme_list[].author` object (snake_case:
//      uid / unique_id / avatar_larger / follower_count) — the FREE
//      subject-entity anchor.
//   4. The profile user is TOP-LEVEL `body.user` (camelCase: id / uniqueId /
//      nickname / avatarLarger), NOT `data.user` (opposite of IG's nesting).
//      Missing handle is HTTP 200 + `error` body with NO `user` → null-by-presence.
//   5. The single video is under `body.aweme_detail` (NOT top-level, NOT `aweme`).
//
// Validate-then-map discipline (mirrors instagram/server/normalize.ts): each
// response is parsed by a zod schema FIRST, then mapped. Fields the spike noted
// as optional are `.nullable().optional()` so a caption-less or metric-less item
// parses cleanly and maps to null (metrics-by-presence — never 0).
//
// PLAT-02: TikTok is the FIRST platform to populate a REAL `shares` metric
// (`statistics.share_count`) — the metric Instagram never had.

import { z } from "zod";
import type {
  FeedOwner,
  NormalizedPost,
  NormalizedSinglePost,
  ProviderPage,
  ResolvedAccount,
} from "$lib/sources/social-provider.js";

// ---- Per-aweme statistics (inline on every item — 10-SPIKE.md Call 1) ----
// All four PLAT-02 metrics present: play_count (views), digg_count (likes),
// comment_count, share_count. Presence-mapped: absent → null, never 0.
const STATISTICS = z
  .object({
    play_count: z.number().nullable().optional(),
    digg_count: z.number().nullable().optional(),
    comment_count: z.number().nullable().optional(),
    share_count: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

// ---- Thumbnail object: prefer dynamic_cover (.awebp, broadly renderable) over
// cover (.heic, Safari-only) per 10-SPIKE.md finding (e). ----
const URL_LIST = z
  .object({ url_list: z.array(z.string()).nullable().optional() })
  .nullable()
  .optional();

const VIDEO = z
  .object({
    dynamic_cover: URL_LIST,
    cover: URL_LIST,
  })
  .nullable()
  .optional();

// ---- Feed-item author (snake_case — the FREE feed owner, 10-SPIKE.md) ----
// DIFFERS from the profile endpoint's camelCase. uid is the stable id;
// unique_id is the renameable @handle.
const AUTHOR = z
  .object({
    uid: z.string().nullable().optional(),
    unique_id: z.string().nullable().optional(),
    nickname: z.string().nullable().optional(),
    avatar_larger: URL_LIST,
    follower_count: z.number().nullable().optional(),
    sec_uid: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

// ---- The aweme shape — IDENTICAL on the feed (aweme_list[]) and the single
// video (aweme_detail), 10-SPIKE.md Call 2. ----
const AWEME = z.object({
  aweme_id: z.string(),
  desc: z.string().nullable().optional(),
  create_time: z.number(), // unix SECONDS (10-SPIKE.md)
  // aweme_type: 0 = video, 150 = photo-mode (TikTok-native convention). Either
  // aweme_type === 150 OR the presence of image_post_info marks photo-mode.
  aweme_type: z.number().nullable().optional(),
  statistics: STATISTICS,
  video: VIDEO,
  // SPIKE: image_post_info inner shape docs-only — Plan 04 live-validates
  // against a real photo-mode post (no slideshow surfaced in the sampled feeds,
  // 10-SPIKE.md). Its PRESENCE is the carousel discriminator and IS confirmed
  // (absent on every sampled video item); only the inner images[] shape is
  // docs-derived, and we read nothing inside it here.
  image_post_info: z.unknown().nullable().optional(),
  author: AUTHOR,
});

type Aweme = z.infer<typeof AWEME>;

/** Photo-mode discriminator → cross-platform content kind. A post is "carousel"
 *  when aweme_type === 150 OR image_post_info is present (10-SPIKE.md finding
 *  (b)); otherwise "video". Per CONTEXT D-03 the media vocabulary for TikTok is
 *  {video, carousel} — we do NOT introduce "short". */
function awemeKind(aweme: Aweme): NormalizedPost["kind"] {
  const isPhotoMode = aweme.aweme_type === 150 || aweme.image_post_info != null;
  return isPhotoMode ? "carousel" : "video";
}

/** Prefer dynamic_cover (.awebp) over cover (.heic) — 10-SPIKE.md finding (e). */
function pickThumbnail(aweme: Aweme): string | null {
  return aweme.video?.dynamic_cover?.url_list?.[0] ?? aweme.video?.cover?.url_list?.[0] ?? null;
}

/** Build the canonical permalink from the author handle + aweme id. The single
 *  video endpoint also keys on this URL shape. Returns null when the handle is
 *  absent (cannot build a valid /@handle/video/<id> permalink). */
function pickPermalink(aweme: Aweme): string | null {
  const handle = aweme.author?.unique_id ?? null;
  if (handle === null) return null;
  return `https://www.tiktok.com/@${handle}/video/${aweme.aweme_id}`;
}

/**
 * Map one TikTok aweme (a feed item or the single-video aweme_detail) to a
 * NormalizedPost. Exported pure so the unit test asserts the mapping directly
 * without spinning up the provider.
 *
 * PLAT-02: `statistics.share_count → metrics.shares` (presence-mapped — the
 * metric Instagram never had). Metrics-by-presence (D-05): a metric whose
 * source field is absent is null, never 0 — e.g. a photo-mode post with no
 * play_count maps views → null.
 */
export function normalizeAweme(aweme: Aweme): NormalizedPost {
  const stats = aweme.statistics ?? undefined;
  return {
    id: aweme.aweme_id,
    kind: awemeKind(aweme),
    publishedAt: new Date(aweme.create_time * 1000), // create_time is unix SECONDS
    metrics: {
      views: stats?.play_count ?? null,
      likes: stats?.digg_count ?? null,
      comments: stats?.comment_count ?? null,
      // PLAT-02 — the real share count TikTok carries inline (presence-mapped).
      shares: stats?.share_count ?? null,
    },
    caption: aweme.desc ?? null,
    thumbnailUrl: pickThumbnail(aweme),
    permalink: pickPermalink(aweme),
  };
}

/** Map a feed-item `author` object → FeedOwner (the FREE owner fields the walker
 *  UPSERTs onto tiktok_accounts with NO extra credit). Returns null when there
 *  is nothing to anchor an account row on (no uid AND no unique_id). The author
 *  is SNAKE_CASE here (vs the profile endpoint's camelCase) — 10-SPIKE.md. */
function pickFeedOwner(author: Aweme["author"]): FeedOwner | null {
  if (author === null || author === undefined) return null;
  const accountId = author.uid ?? null;
  const username = author.unique_id ?? null;
  if (accountId === null && username === null) return null;
  return {
    accountId,
    username,
    avatarUrl: author.avatar_larger?.url_list?.[0] ?? null,
  };
}

// ---- VIDEOS feed response (/v3/tiktok/profile/videos — 10-SPIKE.md Call 1) ----
// FLAT nesting: aweme_list / max_cursor / has_more are TOP-LEVEL. max_cursor is
// a NUMBER (coerce to string for the port). has_more === 1 means more pages.
const VIDEOS_RESPONSE = z.object({
  aweme_list: z.array(AWEME),
  max_cursor: z.number().nullable().optional(),
  has_more: z.number().nullable().optional(),
});

/** Validate + map a videos-feed response → uniform ProviderPage. The cursor
 *  coercion (number → string) and the end-signal (`has_more !== 1`) die here —
 *  callers see only `nextCursor` / `endOfFeed`. The feed owner is read off the
 *  FIRST item's author (every item carries the same author for a profile feed). */
export function normalizeVideosResponse(json: unknown): ProviderPage {
  const parsed = VIDEOS_RESPONSE.parse(json);
  return {
    posts: parsed.aweme_list.map((aweme) => normalizeAweme(aweme)),
    // 10-SPIKE.md deviation 1: max_cursor is a NUMBER → coerce to the port's
    // string cursor. null/absent at end of feed.
    nextCursor:
      parsed.max_cursor !== null && parsed.max_cursor !== undefined
        ? String(parsed.max_cursor)
        : null,
    // has_more === 1 means MORE pages; anything else (0 / absent) is end-of-feed.
    endOfFeed: parsed.has_more !== 1,
    creditsUsed: 1,
    owner: pickFeedOwner(parsed.aweme_list[0]?.author),
  };
}

// ---- SINGLE-VIDEO response (/v2/tiktok/video — 10-SPIKE.md Call 2) ----
// The aweme is under `body.aweme_detail` (NOT top-level, NOT `aweme`). null when
// absent (deleted/private video).
const SINGLE_VIDEO_RESPONSE = z.object({
  aweme_detail: AWEME.nullable().optional(),
});

/**
 * Map one single-video aweme → NormalizedSinglePost (the paste-preview path).
 * `author.uid → ownerId` (stable), `author.unique_id → ownerUsername`
 * (renameable). shares carries through (PLAT-02 for the paste path too).
 * Exported pure so the unit test asserts the mapping directly.
 */
export function normalizeSingleVideo(aweme: Aweme): NormalizedSinglePost {
  const post = normalizeAweme(aweme);
  return {
    id: post.id,
    // TikTok aweme_id IS the URL-intrinsic slug (the /@handle/video/<id> tail),
    // so the shortcode == the id.
    shortcode: aweme.aweme_id,
    kind: post.kind,
    publishedAt: post.publishedAt,
    metrics: post.metrics,
    caption: post.caption,
    thumbnailUrl: post.thumbnailUrl,
    ownerId: aweme.author?.uid ?? null,
    ownerUsername: aweme.author?.unique_id ?? null,
  };
}

/** Validate + map a single-video response → NormalizedSinglePost, or `null` when
 *  the body carries no aweme_detail (deleted/private video — HTTP errors surface
 *  upstream as AdapterError from the HTTP seam, never here). */
export function normalizeSingleVideoResponse(json: unknown): NormalizedSinglePost | null {
  const parsed = SINGLE_VIDEO_RESPONSE.parse(json);
  const aweme = parsed.aweme_detail ?? null;
  if (aweme === null) return null;
  return normalizeSingleVideo(aweme);
}

// ---- PROFILE response (/v1/tiktok/profile — 10-SPIKE.md Call 3) ----
// The user is TOP-LEVEL `body.user` (camelCase), NOT `data.user` (diverges from
// IG). `body.data?.user` is kept ONLY as a defensive fallback. Missing handle is
// HTTP 200 + `error` body with NO `user` → null-by-presence (10-SPIKE.md Call 4).
const PROFILE_USER = z
  .object({
    id: z.string().nullable().optional(),
    uniqueId: z.string().nullable().optional(),
    nickname: z.string().nullable().optional(),
    avatarLarger: z.string().nullable().optional(),
    secUid: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const PROFILE_RESPONSE = z.object({
  user: PROFILE_USER,
  data: z.object({ user: PROFILE_USER }).nullable().optional(),
  stats: z.object({ followerCount: z.number().nullable().optional() }).nullable().optional(),
});

/**
 * Validate + map a profile response → ResolvedAccount, or `null` when the body
 * carries no `user.id` (missing/private handle — TikTok returns HTTP 200 +
 * `error:"Account doesn't exist"` with no `user`, so null-by-presence is the
 * PRIMARY missing-handle signal, NOT HTTP status — 10-SPIKE.md Call 4).
 *
 * `body.user` is read FIRST (the live-confirmed top-level path); `body.data.user`
 * is a defensive fallback only. The avatar / follower fields are read off the
 * SAME response (no extra fetch) to seed the tiktok_accounts subject entity.
 */
export function normalizeProfile(json: unknown): ResolvedAccount | null {
  const parsed = PROFILE_RESPONSE.parse(json);
  const user = parsed.user ?? parsed.data?.user ?? null;
  if (user === null) return null;

  const accountId = user.id ?? null;
  if (accountId === null || accountId === "") return null;

  return {
    accountId,
    displayName: user.nickname ?? user.uniqueId ?? null,
    username: user.uniqueId ?? null,
    fullName: user.nickname ?? null,
    avatarUrl: user.avatarLarger ?? null,
    followerCount: parsed.stats?.followerCount ?? null,
  };
}

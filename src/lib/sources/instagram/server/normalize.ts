// Instagram provider-shape → NormalizedPost mapping.
//
// PURE module: no HTTP, no DB. The two ScrapeCreators endpoints
// (/v2/instagram/user/posts and /v1/instagram/user/reels) return DIFFERENT
// shapes — the posts cursor is top-level `next_max_id`, the reels cursor is
// nested `paging_info.max_id`, and reels nest every metric under `items[].media`.
// This module absorbs that divergence so both endpoints emit one uniform
// ProviderPage. Every field name + cursor path below is a LIVE-CONFIRMED fact
// from 08-SPIKE.md (run against the `nasa` handle, 2026-06-06), NOT the
// documented contract.
//
// Validate-then-map discipline (mirrors youtube/server/adapter.ts): each
// endpoint response is parsed by a zod schema FIRST, then mapped. Fields the
// spike noted as optional are `.nullable().optional()` so a caption-less post
// or a photo with no play_count parses cleanly and maps to null.

import { z } from "zod";
import type { NormalizedPost, ProviderPage } from "$lib/sources/social-provider.js";

// ---- LIVE-CONFIRMED media_type integers (08-SPIKE.md) ----
// 1 = image, 2 = video/reel, 8 = carousel. product_type "clips" ⇒ reel, but a
// reel is still kind "video" — the content SHAPE, not the IG product surface.
function mediaTypeToKind(mediaType: number): NormalizedPost["kind"] {
  switch (mediaType) {
    case 1:
      return "image";
    case 2:
      return "video";
    case 8:
      return "carousel";
    default:
      // Unknown future media_type — treat as image (the safest render shape).
      return "image";
  }
}

// ---- Per-item zod schema (the inner media object on BOTH endpoints) ----
// Posts items ARE this shape directly; reels items wrap it under `.media`.
const IMAGE_VERSIONS2 = z
  .object({
    candidates: z.array(z.object({ url: z.string() })).optional(),
  })
  .nullable()
  .optional();

const CAPTION = z
  .object({
    text: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const MEDIA_ITEM = z.object({
  id: z.string(),
  code: z.string().nullable().optional(), // shortcode → permalink (instagram.com/p/<code>/)
  media_type: z.number(),
  product_type: z.string().nullable().optional(),
  taken_at: z.number(), // unix SECONDS
  like_count: z.number().nullable().optional(),
  comment_count: z.number().nullable().optional(),
  // play_count / ig_play_count present ONLY on media_type=2 (reels) — absent on
  // photos/carousels. Presence is the views signal (D-05).
  play_count: z.number().nullable().optional(),
  ig_play_count: z.number().nullable().optional(),
  caption: CAPTION,
  image_versions2: IMAGE_VERSIONS2,
  video_versions: z
    .array(z.object({ url: z.string() }))
    .nullable()
    .optional(),
});

type MediaItem = z.infer<typeof MEDIA_ITEM>;

// ---- POSTS endpoint response (08-SPIKE.md Call 1) ----
// Cursor `next_max_id` + end signal `more_available` are BOTH top-level.
const POSTS_RESPONSE = z.object({
  items: z.array(MEDIA_ITEM),
  next_max_id: z.string().nullable().optional(),
  more_available: z.boolean().nullable().optional(),
});

// ---- REELS endpoint response (08-SPIKE.md Call 2) ----
// Cursor `max_id` + end signal `more_available` are NESTED under `paging_info`;
// each item wraps the media object under `.media`.
const REELS_RESPONSE = z.object({
  items: z.array(z.object({ media: MEDIA_ITEM })),
  paging_info: z
    .object({
      max_id: z.string().nullable().optional(),
      more_available: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});

function pickThumbnail(item: MediaItem): string | null {
  const imageCandidate = item.image_versions2?.candidates?.[0]?.url ?? null;
  if (imageCandidate !== null) return imageCandidate;
  // Video items always carry image_versions2 (the poster frame); the
  // video_versions URL is the last-resort fallback for any item that
  // somehow lacks an image candidate.
  return item.video_versions?.[0]?.url ?? null;
}

function pickPermalink(item: MediaItem): string | null {
  if (item.code === null || item.code === undefined) return null;
  // Reels and feed posts both resolve under /p/<code>/; /reel/<code>/ also
  // works but /p/ is canonical for either, so we use one shape.
  return `https://www.instagram.com/p/${item.code}/`;
}

/**
 * Map one ScrapeCreators media item (a posts item, or a reels item's `.media`)
 * to a NormalizedPost. Exported pure so the unit test asserts the mapping
 * directly without spinning up the provider.
 *
 * Metrics-by-presence (D-05): `views = play_count ?? ig_play_count ?? null` —
 * a photo/carousel (media_type 1/8) has neither field → null, NOT 0. `shares`
 * is ALWAYS null for Instagram (no share field, D-04 / 08-SPIKE.md).
 */
export function mapItemToNormalizedPost(item: MediaItem): NormalizedPost {
  return {
    id: item.id,
    kind: mediaTypeToKind(item.media_type),
    publishedAt: new Date(item.taken_at * 1000), // taken_at is unix SECONDS
    metrics: {
      views: item.play_count ?? item.ig_play_count ?? null,
      likes: item.like_count ?? null,
      comments: item.comment_count ?? null,
      shares: null, // D-04 — Instagram exposes no share metric in either endpoint
    },
    caption: item.caption?.text ?? null,
    thumbnailUrl: pickThumbnail(item),
    permalink: pickPermalink(item),
  };
}

/** Validate + map a POSTS endpoint response → uniform ProviderPage. */
export function normalizePostsResponse(json: unknown): ProviderPage {
  const parsed = POSTS_RESPONSE.parse(json);
  return {
    posts: parsed.items.map(mapItemToNormalizedPost),
    nextCursor: parsed.next_max_id ?? null,
    endOfFeed: parsed.more_available === false,
    creditsUsed: 1,
  };
}

/**
 * Validate + map a REELS endpoint response → uniform ProviderPage. The reels
 * cursor divergence (`paging_info.max_id` nested vs the posts top-level
 * `next_max_id`) dies here — callers see only `nextCursor`.
 */
export function normalizeReelsResponse(json: unknown): ProviderPage {
  const parsed = REELS_RESPONSE.parse(json);
  return {
    posts: parsed.items.map((entry) => mapItemToNormalizedPost(entry.media)),
    nextCursor: parsed.paging_info?.max_id ?? null,
    endOfFeed: parsed.paging_info?.more_available === false,
    creditsUsed: 1,
  };
}

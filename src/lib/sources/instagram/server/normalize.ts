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
import type {
  NormalizedPost,
  NormalizedSinglePost,
  ProviderPage,
} from "$lib/sources/social-provider.js";

// ---- LIVE-CONFIRMED media_type integers (08-SPIKE.md) ----
// 1 = image, 2 = video/short, 8 = carousel. The integer alone CANNOT tell a
// short-form clip from a plain feed video — both are 2. The discriminator is
// `product_type`: the spike confirmed a short-form clip carries
// product_type === "clips" (a `/p/...` post whose poster frame URL contains
// `CLIPS...video_default_cover_frame`). A plain video (product_type "feed" or
// anything not "clips") stays kind "video". Items from the REELS endpoint are
// short-form by definition — the caller passes `forceShort` so an
// unexpected/absent product_type there still maps to "short". ("short" is the
// unified cross-platform term for the IG-Reels / YT-Shorts / TikTok form.)
function mediaTypeToKind(
  mediaType: number,
  productType: string | null | undefined,
  forceShort: boolean,
): NormalizedPost["kind"] {
  switch (mediaType) {
    case 1:
      return "image";
    case 2:
      return forceShort || productType === "clips" ? "short" : "video";
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
 * `forceShort` is set by the reels-endpoint path: every item from /reels is a
 * short-form clip by definition, so it maps to kind "short" even if
 * `product_type` is absent/unexpected. The posts path leaves it false and
 * relies on `product_type === "clips"` to tell a short from a plain feed video.
 *
 * Metrics-by-presence (D-05): `views = play_count ?? ig_play_count ?? null` —
 * a photo/carousel (media_type 1/8) has neither field → null, NOT 0. `shares`
 * is ALWAYS null for Instagram (no share field, D-04 / 08-SPIKE.md).
 */
export function mapItemToNormalizedPost(item: MediaItem, forceShort = false): NormalizedPost {
  return {
    id: item.id,
    kind: mediaTypeToKind(item.media_type, item.product_type, forceShort),
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
    // Explicit lambda — NOT a bare `.map(mapItemToNormalizedPost)`: Array.map
    // passes the index as the 2nd arg, which would bind to `forceShort`. The
    // posts path leaves forceShort false (product_type discriminates shorts).
    posts: parsed.items.map((item) => mapItemToNormalizedPost(item)),
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
    posts: parsed.items.map((entry) => mapItemToNormalizedPost(entry.media, true)),
    nextCursor: parsed.paging_info?.max_id ?? null,
    endOfFeed: parsed.paging_info?.more_available === false,
    creditsUsed: 1,
  };
}

// ---- SINGLE-POST endpoint response (/v1/instagram/post?url=) ----
//
// LIVE-CONFIRMED shape (08-issue-65, 2026-06-06). The single-post GraphQL
// surface DIFFERS from the feed-item shape used above:
//   - content form is `__typename` (XDTGraphImage | XDTGraphVideo |
//     XDTGraphSidecar), NOT the integer media_type the feed endpoints use, and
//     there is NO product_type — so short-vs-video is decided by the URL shape
//     (a `/reel/` permalink → "short") in mapSinglePostToNormalized, NOT here.
//   - caption is nested under edge_media_to_caption.edges[0].node.text.
//   - counts are nested edge `.count`s (likes/comments) + top-level
//     video_play_count / video_view_count (videos only).
//   - taken_at_timestamp is unix SECONDS; thumbnail_src is the poster frame.
const XDT_SHORTCODE_MEDIA = z.object({
  __typename: z.string().nullable().optional(),
  id: z.string(),
  shortcode: z.string().nullable().optional(),
  is_video: z.boolean().nullable().optional(),
  taken_at_timestamp: z.number(),
  thumbnail_src: z.string().nullable().optional(),
  video_play_count: z.number().nullable().optional(),
  video_view_count: z.number().nullable().optional(),
  edge_media_preview_like: z
    .object({ count: z.number().nullable().optional() })
    .nullable()
    .optional(),
  edge_media_to_parent_comment: z
    .object({ count: z.number().nullable().optional() })
    .nullable()
    .optional(),
  edge_media_to_caption: z
    .object({
      edges: z
        .array(z.object({ node: z.object({ text: z.string().nullable().optional() }) }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  owner: z
    .object({
      id: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const SINGLE_POST_RESPONSE = z.object({
  data: z
    .object({
      xdt_shortcode_media: XDT_SHORTCODE_MEDIA.nullable().optional(),
    })
    .nullable()
    .optional(),
});

type XdtMedia = z.infer<typeof XDT_SHORTCODE_MEDIA>;

/** Resolve the cross-platform content form from the single-post `__typename`
 *  combined with the permalink. The single-post API has no product_type, so a
 *  `/reel/` permalink is the ONLY short-vs-video discriminator (08-issue-65):
 *  a `/reel/` URL → "short"; an `/p/` XDTGraphVideo → "video"; XDTGraphImage →
 *  "image"; XDTGraphSidecar → "carousel". */
function typenameToKind(
  typename: string | null | undefined,
  isReelUrl: boolean,
): NormalizedSinglePost["kind"] {
  switch (typename) {
    case "XDTGraphImage":
      return "image";
    case "XDTGraphSidecar":
      return "carousel";
    case "XDTGraphVideo":
      return isReelUrl ? "short" : "video";
    default:
      // Unknown future typename — fall back on the URL shape, else "image".
      return isReelUrl ? "short" : "image";
  }
}

/**
 * Map one `data.xdt_shortcode_media` object → NormalizedSinglePost. Exported
 * pure so the unit test asserts the mapping (and the reel-vs-`/p/`
 * media_type rule) directly without spinning up the provider.
 *
 * `isReelUrl` is derived by the caller from the pasted permalink (a `/reel/`
 * path). Metrics-by-presence (D-05): a photo/carousel has no play/view count →
 * views null; likes/comments fall back to null when the edge count is absent.
 */
export function mapSinglePostToNormalized(
  media: XdtMedia,
  isReelUrl: boolean,
): NormalizedSinglePost {
  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text ?? null;
  return {
    id: media.id,
    shortcode: media.shortcode ?? null,
    kind: typenameToKind(media.__typename, isReelUrl),
    publishedAt: new Date(media.taken_at_timestamp * 1000), // unix SECONDS
    metrics: {
      views: media.video_play_count ?? media.video_view_count ?? null,
      likes: media.edge_media_preview_like?.count ?? null,
      comments: media.edge_media_to_parent_comment?.count ?? null,
    },
    caption,
    thumbnailUrl: media.thumbnail_src ?? null,
    ownerId: media.owner?.id ?? null,
    ownerUsername: media.owner?.username ?? null,
  };
}

/** Validate + map a single-post response → NormalizedSinglePost, or `null`
 *  when the body carries no media object (deleted/private post returns the
 *  envelope with a null `xdt_shortcode_media`; HTTP errors surface upstream as
 *  AdapterError from the HTTP seam, never here). */
export function normalizeSinglePostResponse(
  json: unknown,
  isReelUrl: boolean,
): NormalizedSinglePost | null {
  const parsed = SINGLE_POST_RESPONSE.parse(json);
  const media = parsed.data?.xdt_shortcode_media ?? null;
  if (media === null) return null;
  return mapSinglePostToNormalized(media, isReelUrl);
}

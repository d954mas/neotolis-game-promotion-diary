// The IG provider-shape → NormalizedPost normalization mapping (Plan 08-02).
// Requirements: SOC-04, D-04/D-05.
//
// Fixtures mirror the LIVE-CONFIRMED ScrapeCreators shapes from 08-SPIKE.md
// (run against `nasa`, 2026-06-06): media_type ints 1/2/8, taken_at unix
// SECONDS, caption.text path, play_count present only on media_type=2,
// posts cursor next_max_id (top-level) vs reels cursor paging_info.max_id
// (nested), reels items nested under `.media` and DO carry captions.
//
// Pure unit test — no DB, no live HTTP.
import { describe, it, expect } from "vitest";
import {
  mapItemToNormalizedPost,
  mapSinglePostToNormalized,
  normalizePostsResponse,
  normalizeReelsResponse,
  normalizeSinglePostResponse,
} from "$lib/sources/instagram/server/normalize.js";

// A media_type=2 + product_type "clips" item — a REEL (the spike-confirmed
// reel marker). Has play_count + ig_play_count.
const REEL_ITEM = {
  id: "3896292935179184980_12109747",
  code: "DYSacf2OCta",
  media_type: 2,
  product_type: "clips",
  taken_at: 1780416264, // unix seconds → 2026-...
  like_count: 566369,
  comment_count: 2148,
  play_count: 4738925,
  ig_play_count: 4738925,
  caption: { text: "First light from the new instrument." },
  image_versions2: { candidates: [{ url: "https://cdn.example/poster.jpg" }] },
  video_versions: [{ url: "https://cdn.example/video.mp4" }],
};

// A media_type=2 + product_type "feed" item — a PLAIN long-form feed VIDEO
// (NOT a reel). Same integer media_type as a reel; only product_type tells
// them apart. Also carries play_count.
const VIDEO_ITEM = {
  id: "3896292935179184980_99999999",
  code: "DYfeedVideo",
  media_type: 2,
  product_type: "feed",
  taken_at: 1780410000,
  like_count: 120,
  comment_count: 8,
  play_count: 5400,
  ig_play_count: 5400,
  caption: { text: "A long-form feed video." },
  image_versions2: { candidates: [{ url: "https://cdn.example/video-poster.jpg" }] },
  video_versions: [{ url: "https://cdn.example/feed-video.mp4" }],
};

// A media_type=1 (photo) item — NO play_count / ig_play_count fields at all.
const PHOTO_ITEM = {
  id: "3896000000000000000_12109747",
  code: "DYphotoCode",
  media_type: 1,
  product_type: "feed",
  taken_at: 1780300000,
  like_count: 12000,
  comment_count: 87,
  caption: { text: "A wide-field view." },
  image_versions2: { candidates: [{ url: "https://cdn.example/photo.jpg" }] },
};

// A media_type=8 (carousel) item — also no play_count.
const CAROUSEL_ITEM = {
  id: "3896111111111111111_12109747",
  code: "DYcarouselCode",
  media_type: 8,
  product_type: "carousel_container",
  taken_at: 1780200000,
  like_count: 9000,
  comment_count: 40,
  caption: null, // caption-less post → fallback title territory (D-09)
  image_versions2: { candidates: [{ url: "https://cdn.example/carousel.jpg" }] },
};

describe("instagram normalizer (provider shape -> NormalizedPost)", () => {
  it("maps a provider posts-shape REEL item to NormalizedPost", () => {
    const np = mapItemToNormalizedPost(REEL_ITEM);
    expect(np.id).toBe("3896292935179184980_12109747");
    // product_type "clips" ⇒ kind "short" (distinct from a plain video).
    expect(np.kind).toBe("short");
    // taken_at is unix SECONDS → publishedAt multiplies by 1000.
    expect(np.publishedAt.getTime()).toBe(1780416264 * 1000);
    expect(np.metrics.likes).toBe(566369);
    expect(np.metrics.comments).toBe(2148);
    expect(np.caption).toBe("First light from the new instrument.");
    expect(np.thumbnailUrl).toBe("https://cdn.example/poster.jpg");
    expect(np.permalink).toBe("https://www.instagram.com/p/DYSacf2OCta/");
  });

  it("distinguishes a short (product_type=clips) from a plain video (product_type=feed)", () => {
    // Both are integer media_type 2 — only product_type tells them apart.
    // This FAILS on the pre-fix collapse-to-"video" behavior (which mapped
    // every media_type=2 item to kind "video" and dropped the clips signal).
    expect(mapItemToNormalizedPost(REEL_ITEM).kind).toBe("short");
    expect(mapItemToNormalizedPost(VIDEO_ITEM).kind).toBe("video");

    // A photo (1) and carousel (8) are unaffected by the short distinction.
    expect(mapItemToNormalizedPost(PHOTO_ITEM).kind).toBe("image");
    expect(mapItemToNormalizedPost(CAROUSEL_ITEM).kind).toBe("carousel");
  });

  it("metrics by presence: a photo (media_type=1) has null views; a short (media_type=2) maps play_count -> views", () => {
    const short = mapItemToNormalizedPost(REEL_ITEM);
    expect(short.metrics.views).toBe(4738925);

    const photo = mapItemToNormalizedPost(PHOTO_ITEM);
    expect(photo.kind).toBe("image");
    // D-05: play_count absent on a photo → views is null, NOT 0.
    expect(photo.metrics.views).toBeNull();

    const carousel = mapItemToNormalizedPost(CAROUSEL_ITEM);
    expect(carousel.kind).toBe("carousel");
    expect(carousel.metrics.views).toBeNull();
  });

  it("shares is always null for Instagram", () => {
    expect(mapItemToNormalizedPost(REEL_ITEM).metrics.shares).toBeNull();
    expect(mapItemToNormalizedPost(PHOTO_ITEM).metrics.shares).toBeNull();
    expect(mapItemToNormalizedPost(CAROUSEL_ITEM).metrics.shares).toBeNull();
  });

  it("caption-less post maps caption to null (D-09 fallback territory)", () => {
    expect(mapItemToNormalizedPost(CAROUSEL_ITEM).caption).toBeNull();
  });

  it("normalizePostsResponse reads the TOP-LEVEL next_max_id cursor + more_available end signal", () => {
    const page = normalizePostsResponse({
      items: [REEL_ITEM, VIDEO_ITEM, PHOTO_ITEM, CAROUSEL_ITEM],
      next_max_id: "3902016900730110147_12109747",
      more_available: true,
    });
    expect(page.posts).toHaveLength(4);
    // The posts endpoint distinguishes all four forms via product_type.
    expect(page.posts.map((p) => p.kind)).toEqual(["short", "video", "image", "carousel"]);
    expect(page.nextCursor).toBe("3902016900730110147_12109747");
    expect(page.endOfFeed).toBe(false);
    expect(page.creditsUsed).toBe(1);
  });

  it("normalizePostsResponse: more_available=false signals end of feed", () => {
    const page = normalizePostsResponse({
      items: [PHOTO_ITEM],
      next_max_id: null,
      more_available: false,
    });
    expect(page.endOfFeed).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it("normalizeReelsResponse reads the NESTED paging_info.max_id cursor + unwraps items[].media", () => {
    const page = normalizeReelsResponse({
      items: [{ media: REEL_ITEM }],
      paging_info: { max_id: "QVFCX1E0WHRuWE50c3p2QTU1SHJj", more_available: true },
    });
    expect(page.posts).toHaveLength(1);
    // Reels DO carry captions (supersedes RESEARCH Pitfall 8) — real caption used.
    expect(page.posts[0]!.caption).toBe("First light from the new instrument.");
    expect(page.posts[0]!.metrics.views).toBe(4738925);
    // Every reels-endpoint item is short-form by definition → kind "short".
    expect(page.posts[0]!.kind).toBe("short");
    // The cursor divergence is absorbed: caller sees only nextCursor.
    expect(page.nextCursor).toBe("QVFCX1E0WHRuWE50c3p2QTU1SHJj");
    expect(page.endOfFeed).toBe(false);
    expect(page.creditsUsed).toBe(1);
  });

  it("normalizeReelsResponse: a reels item with NO/unexpected product_type still maps to short", () => {
    // The reels endpoint forces kind "short" regardless of product_type — an
    // item that arrived without "clips" must NOT collapse to "video".
    const reelNoProductType = { ...VIDEO_ITEM, product_type: null };
    const page = normalizeReelsResponse({
      items: [{ media: reelNoProductType }],
      paging_info: { max_id: null, more_available: false },
    });
    expect(page.posts[0]!.kind).toBe("short");
  });

  it("normalizeReelsResponse: paging_info.more_available=false signals end of feed", () => {
    const page = normalizeReelsResponse({
      items: [{ media: REEL_ITEM }],
      paging_info: { max_id: null, more_available: false },
    });
    expect(page.endOfFeed).toBe(true);
    expect(page.nextCursor).toBeNull();
  });
});

// ---- Single-post (/v1/instagram/post?url=) shape (issue #65) ----
// The single-post GraphQL surface uses __typename (NOT integer media_type) and
// has NO product_type, so a `/reel/` permalink is the ONLY short-vs-video
// discriminator. LIVE-CONFIRMED fields: edge_media_to_caption.edges[0].node.text,
// edge_media_preview_like.count, edge_media_to_parent_comment.count,
// video_play_count, thumbnail_src, taken_at_timestamp (unix seconds), owner.
const XDT_IMAGE = {
  __typename: "XDTGraphImage",
  // BARE media pk — the single-post GraphQL endpoint returns no owner suffix
  // (unlike the feed/reels endpoints). The normalizer must reconstruct the
  // canonical `<pk>_<owner>` key (#69) so a paste matches the source.
  id: "111",
  shortcode: "DPhotoCode",
  is_video: false,
  taken_at_timestamp: 1780300000,
  thumbnail_src: "https://cdn.example/single-photo.jpg",
  edge_media_preview_like: { count: 4200 },
  edge_media_to_parent_comment: { count: 33 },
  edge_media_to_caption: {
    edges: [{ node: { text: "First line of the caption\nSecond line dropped" } }],
  },
  owner: { id: "222", username: "neonicle_dev" },
};

const XDT_VIDEO = {
  __typename: "XDTGraphVideo",
  id: "333_444",
  shortcode: "DVideoCode",
  is_video: true,
  taken_at_timestamp: 1780400000,
  thumbnail_src: "https://cdn.example/single-video.jpg",
  video_play_count: 99000,
  video_view_count: 99000,
  edge_media_preview_like: { count: 500 },
  edge_media_to_parent_comment: { count: 12 },
  edge_media_to_caption: { edges: [{ node: { text: "A video caption." } }] },
  owner: { id: "owner-2", username: "video_owner" },
};

const XDT_SIDECAR = {
  __typename: "XDTGraphSidecar",
  id: "555_666",
  shortcode: "DCarouselCode",
  is_video: false,
  taken_at_timestamp: 1780200000,
  thumbnail_src: "https://cdn.example/single-carousel.jpg",
  edge_media_preview_like: { count: 700 },
  edge_media_to_parent_comment: { count: 5 },
  edge_media_to_caption: { edges: [] }, // caption-less → null
  owner: { id: "owner-3", username: "carousel_owner" },
};

describe("instagram single-post normalizer (xdt_shortcode_media -> NormalizedSinglePost)", () => {
  it("XDTGraphImage maps to kind 'image' and reads the nested caption/like/comment counts", () => {
    const post = mapSinglePostToNormalized(XDT_IMAGE, false);
    expect(post.kind).toBe("image");
    // Canonical id = `<pk>_<owner>` reconstructed from the bare-pk `id` (111) +
    // owner.id (222), matching the feed/reels key so a paste shares the cache
    // row + polling with the source-imported post (#69).
    expect(post.id).toBe("111_222");
    expect(post.shortcode).toBe("DPhotoCode");
    // Caption is the FULL multi-line text (the first-line split happens at the
    // title-build layer, NOT in the normalizer).
    expect(post.caption).toBe("First line of the caption\nSecond line dropped");
    expect(post.metrics.likes).toBe(4200);
    expect(post.metrics.comments).toBe(33);
    expect(post.metrics.views).toBeNull(); // photo → no play_count (D-05)
    expect(post.thumbnailUrl).toBe("https://cdn.example/single-photo.jpg");
    expect(post.ownerId).toBe("222");
    expect(post.ownerUsername).toBe("neonicle_dev");
    // taken_at_timestamp is unix SECONDS.
    expect(post.publishedAt.toISOString()).toBe(new Date(1780300000 * 1000).toISOString());
  });

  it("leaves an already-suffixed single-post id unchanged (defensive, no double-suffix) — #69", () => {
    const post = mapSinglePostToNormalized(
      { ...XDT_IMAGE, id: "999_888", owner: { id: "888", username: "x" } },
      false,
    );
    expect(post.id).toBe("999_888");
  });

  it("falls back to the bare pk when the single-post response carries no owner id — #69", () => {
    const post = mapSinglePostToNormalized({ ...XDT_IMAGE, id: "777", owner: null }, false);
    expect(post.id).toBe("777");
  });

  it("XDTGraphVideo on a /p/ URL (isReelUrl=false) maps to 'video' and reads video_play_count", () => {
    const post = mapSinglePostToNormalized(XDT_VIDEO, false);
    expect(post.kind).toBe("video");
    expect(post.metrics.views).toBe(99000);
  });

  it("XDTGraphVideo on a /reel/ URL (isReelUrl=true) maps to 'short' (the URL is the discriminator)", () => {
    const post = mapSinglePostToNormalized(XDT_VIDEO, true);
    expect(post.kind).toBe("short");
  });

  it("XDTGraphSidecar maps to 'carousel'; an empty caption edges array → null caption", () => {
    const post = mapSinglePostToNormalized(XDT_SIDECAR, false);
    expect(post.kind).toBe("carousel");
    expect(post.caption).toBeNull();
  });

  it("normalizeSinglePostResponse: parses data.xdt_shortcode_media + applies the reel-URL rule", () => {
    const reel = normalizeSinglePostResponse({ data: { xdt_shortcode_media: XDT_VIDEO } }, true);
    expect(reel?.kind).toBe("short");

    const photo = normalizeSinglePostResponse({ data: { xdt_shortcode_media: XDT_IMAGE } }, false);
    expect(photo?.kind).toBe("image");
  });

  it("normalizeSinglePostResponse: a null media object (deleted/private) returns null", () => {
    expect(normalizeSinglePostResponse({ data: { xdt_shortcode_media: null } }, false)).toBeNull();
    expect(normalizeSinglePostResponse({ data: {} }, false)).toBeNull();
    expect(normalizeSinglePostResponse({}, false)).toBeNull();
  });
});

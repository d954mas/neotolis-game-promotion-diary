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
  normalizePostsResponse,
  normalizeReelsResponse,
} from "$lib/sources/instagram/server/normalize.js";

// A media_type=2 (video/reel) item — has play_count + ig_play_count.
const VIDEO_ITEM = {
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
  it("maps a provider posts-shape item to NormalizedPost", () => {
    const np = mapItemToNormalizedPost(VIDEO_ITEM);
    expect(np.id).toBe("3896292935179184980_12109747");
    expect(np.kind).toBe("video");
    // taken_at is unix SECONDS → publishedAt multiplies by 1000.
    expect(np.publishedAt.getTime()).toBe(1780416264 * 1000);
    expect(np.metrics.likes).toBe(566369);
    expect(np.metrics.comments).toBe(2148);
    expect(np.caption).toBe("First light from the new instrument.");
    expect(np.thumbnailUrl).toBe("https://cdn.example/poster.jpg");
    expect(np.permalink).toBe("https://www.instagram.com/p/DYSacf2OCta/");
  });

  it("metrics by presence: a photo (media_type=1) has null views; a reel (media_type=2) maps play_count -> views", () => {
    const reel = mapItemToNormalizedPost(VIDEO_ITEM);
    expect(reel.metrics.views).toBe(4738925);

    const photo = mapItemToNormalizedPost(PHOTO_ITEM);
    expect(photo.kind).toBe("image");
    // D-05: play_count absent on a photo → views is null, NOT 0.
    expect(photo.metrics.views).toBeNull();

    const carousel = mapItemToNormalizedPost(CAROUSEL_ITEM);
    expect(carousel.kind).toBe("carousel");
    expect(carousel.metrics.views).toBeNull();
  });

  it("shares is always null for Instagram", () => {
    expect(mapItemToNormalizedPost(VIDEO_ITEM).metrics.shares).toBeNull();
    expect(mapItemToNormalizedPost(PHOTO_ITEM).metrics.shares).toBeNull();
    expect(mapItemToNormalizedPost(CAROUSEL_ITEM).metrics.shares).toBeNull();
  });

  it("caption-less post maps caption to null (D-09 fallback territory)", () => {
    expect(mapItemToNormalizedPost(CAROUSEL_ITEM).caption).toBeNull();
  });

  it("normalizePostsResponse reads the TOP-LEVEL next_max_id cursor + more_available end signal", () => {
    const page = normalizePostsResponse({
      items: [VIDEO_ITEM, PHOTO_ITEM, CAROUSEL_ITEM],
      next_max_id: "3902016900730110147_12109747",
      more_available: true,
    });
    expect(page.posts).toHaveLength(3);
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
      items: [{ media: VIDEO_ITEM }],
      paging_info: { max_id: "QVFCX1E0WHRuWE50c3p2QTU1SHJj", more_available: true },
    });
    expect(page.posts).toHaveLength(1);
    // Reels DO carry captions (supersedes RESEARCH Pitfall 8) — real caption used.
    expect(page.posts[0]!.caption).toBe("First light from the new instrument.");
    expect(page.posts[0]!.metrics.views).toBe(4738925);
    // The cursor divergence is absorbed: caller sees only nextCursor.
    expect(page.nextCursor).toBe("QVFCX1E0WHRuWE50c3p2QTU1SHJj");
    expect(page.endOfFeed).toBe(false);
    expect(page.creditsUsed).toBe(1);
  });

  it("normalizeReelsResponse: paging_info.more_available=false signals end of feed", () => {
    const page = normalizeReelsResponse({
      items: [{ media: VIDEO_ITEM }],
      paging_info: { max_id: null, more_available: false },
    });
    expect(page.endOfFeed).toBe(true);
    expect(page.nextCursor).toBeNull();
  });
});

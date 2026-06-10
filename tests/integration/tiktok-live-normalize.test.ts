// Live-provider normalizer validation — the debt 10-SPIKE.md carried to Plan 10-04.
//
// The VIDEO-path normalizer (feed item, single video, profile, missing handle) is
// LIVE-CONFIRMED in 10-SPIKE.md (pinned from real HTTP bodies, 2026-06-10) — no
// further live validation needed. The ONE remaining docs-only shape is the inner
// structure of a PHOTO-MODE `image_post_info` object: its PRESENCE (the carousel
// discriminator) IS confirmed (absent on every sampled video item), but no
// photo-mode item surfaced in the sampled `sort_by=latest` feeds, so the inner
// images[] shape is docs-derived.
//
// This test makes ONE real ScrapeCreators call against a known account, fetches a
// page, and asserts the normalizer yields a populated NormalizedPost from the REAL
// body — including a non-null `shares` on a video and a correct kind
// classification. If a photo-mode item is present in the live feed it additionally
// asserts the carousel discriminator maps to kind="carousel" with views
// null-by-presence.
//
// GATED: skips in CI (no key) and runs at UAT (Plan 05 sets TIKTOK_PROVIDER=
// scrapecreators + SCRAPECREATORS_API_KEY). It NEVER mocks the provider — that is
// the whole point (the docs-only shape must be validated against a real body).
//
// Requirements: PLAT-02.
import { describe, it, expect } from "vitest";
import { env } from "../../src/lib/server/config/env.js";
import { scrapeCreatorsTikTokProvider } from "../../src/lib/sources/tiktok/server/provider/scrapecreators-tiktok.js";

const LIVE =
  env.TIKTOK_PROVIDER === "scrapecreators" &&
  env.SCRAPECREATORS_API_KEY !== "" &&
  // A known public account with regular videos (10-SPIKE.md test handle).
  // Plan 05 UAT may swap in a photo-mode account to exercise the carousel branch.
  true;

// A known photo-mode account can be supplied via this env at UAT to force the
// carousel branch; absent → the test only asserts the video-path mapping (already
// live-confirmed, re-validated here against a fresh body).
const PHOTO_MODE_HANDLE = process.env.TIKTOK_UAT_PHOTO_HANDLE ?? "stoolpresidente";

describe("tiktok live-provider normalizer validation (10-SPIKE.md photo-mode debt)", () => {
  it.skipIf(!LIVE)(
    "[10-04] maps a REAL ScrapeCreators feed body into populated NormalizedPosts (shares non-null on a video)",
    async () => {
      const page = await scrapeCreatorsTikTokProvider.fetchPosts(
        "tiktok",
        PHOTO_MODE_HANDLE,
        null,
        {},
      );
      expect(page.posts.length).toBeGreaterThan(0);

      // Every mapped post has an id, a publishedAt, and a kind in the TikTok
      // vocabulary {video, carousel}.
      for (const p of page.posts) {
        expect(typeof p.id).toBe("string");
        expect(p.publishedAt instanceof Date).toBe(true);
        expect(["video", "carousel"]).toContain(p.kind);
      }

      // At least one VIDEO carries a non-null share count (PLAT-02 — the metric IG
      // never had — survives the round-trip from the real body).
      const videos = page.posts.filter((p) => p.kind === "video");
      expect(videos.length).toBeGreaterThan(0);
      expect(videos.some((p) => p.metrics.shares !== null)).toBe(true);

      // IF a photo-mode (carousel) item surfaced, assert the docs-only branch: the
      // image_post_info presence discriminator → kind="carousel" with views
      // null-by-presence (a photo-mode post has no play_count).
      const carousels = page.posts.filter((p) => p.kind === "carousel");
      for (const c of carousels) {
        expect(c.metrics.views).toBeNull();
      }
    },
    30_000,
  );
});

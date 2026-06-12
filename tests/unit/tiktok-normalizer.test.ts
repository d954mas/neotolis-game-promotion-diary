// TikTok response normalizer — aweme → NormalizedPost / single-video →
// NormalizedSinglePost, with share metrics threaded (PLAT-02) and photo-mode
// handling (carousel media_type, views null by presence) + the provider's
// endpoint/cursor/credit mapping. Pure unit test — no DB, no live HTTP (the
// provider's HTTP boundary is mocked).
//
// Fixtures mirror the LIVE-CONFIRMED ScrapeCreators shapes from 10-SPIKE.md (run
// against `stoolpresidente` / `zachking`, 2026-06-10): aweme_list TOP-LEVEL,
// max_cursor a NUMBER, has_more === 1 = more, create_time unix SECONDS,
// statistics.share_count inline (PLAT-02), single video under aweme_detail,
// profile user TOP-LEVEL body.user (camelCase), feed owner on
// aweme_list[].author (snake_case).
//
// Requirements: PLAT-02, SOC-02/03/04.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeAweme,
  normalizeProfile,
  normalizeSingleVideo,
  normalizeSingleVideoResponse,
  normalizeVideosResponse,
} from "$lib/sources/tiktok/server/normalize.js";

// A regular video aweme (aweme_type 0, no image_post_info) with all four
// PLAT-02 metrics inline + snake_case author.
const VIDEO_AWEME = {
  aweme_id: "7649569886871522573",
  desc: "#teabythesea They said my name episode",
  create_time: 1781054302, // unix seconds
  aweme_type: 0,
  statistics: {
    play_count: 1_200_000,
    digg_count: 80_000,
    comment_count: 3_400,
    share_count: 4974, // PLAT-02 — the metric IG never had
  },
  video: {
    dynamic_cover: { url_list: ["https://p.tiktokcdn-us.com/cover.awebp"] },
    cover: { url_list: ["https://p.tiktokcdn-us.com/cover.heic"] },
  },
  author: {
    uid: "6659752019493208069",
    unique_id: "stoolpresidente",
    nickname: "Dave Portnoy",
    avatar_larger: { url_list: ["https://p.tiktokcdn-us.com/avatar.jpeg"] },
    follower_count: 4_700_000,
    sec_uid: "MS4wLjABAAAA",
  },
};

// A photo-mode aweme (aweme_type 150 + image_post_info present), NO play_count.
const PHOTO_AWEME = {
  aweme_id: "7600000000000000001",
  desc: "slideshow post",
  create_time: 1781000000,
  aweme_type: 150,
  image_post_info: { images: [{ display_image: { url_list: ["https://cdn/photo.jpg"] } }] },
  statistics: {
    // No play_count on a photo-mode post — views must map null-by-presence.
    digg_count: 500,
    comment_count: 12,
    share_count: 7,
  },
  video: null,
  author: {
    uid: "6659752019493208069",
    unique_id: "stoolpresidente",
  },
};

describe("tiktok normalizer (PLAT-02)", () => {
  it("[10-03] maps an aweme feed item to NormalizedPost including a real shares count", () => {
    const post = normalizeAweme(VIDEO_AWEME);
    expect(post).toEqual({
      id: "7649569886871522573",
      kind: "video",
      publishedAt: new Date(1781054302 * 1000),
      metrics: { views: 1_200_000, likes: 80_000, comments: 3_400, shares: 4974 },
      caption: "#teabythesea They said my name episode",
      // Prefers dynamic_cover (.awebp) over cover (.heic).
      thumbnailUrl: "https://p.tiktokcdn-us.com/cover.awebp",
      permalink: "https://www.tiktok.com/@stoolpresidente/video/7649569886871522573",
    });
  });

  it("[10-03] maps a single video to NormalizedSinglePost including shares (the IG-omitted metric)", () => {
    const single = normalizeSingleVideo(VIDEO_AWEME);
    expect(single.id).toBe("7649569886871522573");
    expect(single.shortcode).toBe("7649569886871522573");
    expect(single.kind).toBe("video");
    expect(single.metrics.shares).toBe(4974);
    expect(single.ownerId).toBe("6659752019493208069");
    expect(single.ownerUsername).toBe("stoolpresidente");
  });

  it("[10-03] photo-mode posts map to media_type 'carousel' with views null by presence", () => {
    const post = normalizeAweme(PHOTO_AWEME);
    expect(post.kind).toBe("carousel");
    // play_count absent → views null, NEVER 0.
    expect(post.metrics.views).toBeNull();
    // The other present metrics still map.
    expect(post.metrics.likes).toBe(500);
    expect(post.metrics.shares).toBe(7);
  });

  it("[10-03] a metric absent on this content type is null, never 0 (metrics-by-presence)", () => {
    const post = normalizeAweme({
      aweme_id: "1",
      create_time: 1781000000,
      aweme_type: 0,
      // statistics entirely absent → every metric null.
      author: { uid: "u", unique_id: "h" },
    });
    expect(post.metrics).toEqual({ views: null, likes: null, comments: null, shares: null });
  });

  it("[10-03] a post with no image_post_info AND aweme_type 0 is a video (carousel discriminator)", () => {
    expect(normalizeAweme(VIDEO_AWEME).kind).toBe("video");
    // Presence of image_post_info alone (even without aweme_type 150) → carousel.
    expect(normalizeAweme({ ...VIDEO_AWEME, aweme_type: 0, image_post_info: {} }).kind).toBe(
      "carousel",
    );
  });

  it("[10-03] normalizeProfile reads the top-level body.user (NOT data.user, unlike IG)", () => {
    const account = normalizeProfile({
      success: true,
      user: {
        id: "6659752019493208069",
        uniqueId: "stoolpresidente",
        nickname: "Dave Portnoy",
        avatarLarger: "https://cdn/avatar.jpeg",
        secUid: "MS4wLjABAAAA",
      },
      stats: { followerCount: 4_700_000 },
    });
    expect(account).toEqual({
      accountId: "6659752019493208069",
      displayName: "Dave Portnoy",
      username: "stoolpresidente",
      fullName: "Dave Portnoy",
      avatarUrl: "https://cdn/avatar.jpeg",
      followerCount: 4_700_000,
      // C2: sec_uid is read off the SAME profile response (no extra fetch) and
      // threaded into the create-time tiktok_accounts seed.
      secUid: "MS4wLjABAAAA",
    });
  });

  it("[10-03] normalizeProfile maps secUid → null when the profile omits it", () => {
    const account = normalizeProfile({
      success: true,
      user: { id: "1", uniqueId: "h", nickname: "N" },
    });
    expect(account?.secUid).toBeNull();
  });

  it("[10-03] normalizeProfile returns null for the missing-handle 200 body (no user)", () => {
    // TikTok returns HTTP 200 + error body with NO `user` for a missing handle
    // (10-SPIKE.md Call 4) — null-by-presence, NOT by HTTP status.
    expect(normalizeProfile({ success: true, error: "Account doesn't exist" })).toBeNull();
  });

  it("[10-03] normalizeVideosResponse coerces the NUMBER max_cursor to a string + maps has_more", () => {
    const page = normalizeVideosResponse({
      aweme_list: [VIDEO_AWEME],
      max_cursor: 1779902811265, // a NUMBER live (10-SPIKE.md deviation 1)
      has_more: 1,
    });
    expect(page.nextCursor).toBe("1779902811265");
    expect(typeof page.nextCursor).toBe("string");
    expect(page.endOfFeed).toBe(false);
    expect(page.posts).toHaveLength(1);
    // FREE feed owner read off aweme_list[0].author (snake_case).
    expect(page.owner).toEqual({
      accountId: "6659752019493208069",
      username: "stoolpresidente",
      avatarUrl: "https://p.tiktokcdn-us.com/avatar.jpeg",
    });
  });

  it("[10-03] endOfFeed is true when has_more !== 1", () => {
    const page = normalizeVideosResponse({ aweme_list: [VIDEO_AWEME], max_cursor: 0, has_more: 0 });
    expect(page.endOfFeed).toBe(true);
  });

  it("BOOLEAN has_more variant (small single-page accounts): false = end-of-feed, true = more", () => {
    // Live failure 2026-06-12 (@d954mas_make_games): the upstream returns
    // has_more as a BOOLEAN for single-page accounts while large accounts get
    // numeric 1/0 — the schema must accept both shapes.
    const done = normalizeVideosResponse({
      aweme_list: [VIDEO_AWEME],
      max_cursor: 0,
      has_more: false,
    });
    expect(done.endOfFeed).toBe(true);
    const more = normalizeVideosResponse({
      aweme_list: [VIDEO_AWEME],
      max_cursor: 1779902811265,
      has_more: true,
    });
    expect(more.endOfFeed).toBe(false);
    expect(more.nextCursor).toBe("1779902811265");
  });

  it("[10-03] a FALSY max_cursor (0) coerces to nextCursor null, not '0' (FIX 6)", () => {
    // 0 is never a resumable position (live cursors are epoch-millis scale); coercing
    // it to "0" would defeat backfill-account's Pitfall-4 heuristic (cursor===null)
    // and re-enqueue a dead page forever. Empty feed at end-of-feed → null cursor.
    const page = normalizeVideosResponse({ aweme_list: [], max_cursor: 0, has_more: 0 });
    expect(page.nextCursor).toBeNull();
    expect(page.endOfFeed).toBe(true);
    expect(page.posts).toHaveLength(0);
  });

  it("[10-03] normalizeSingleVideoResponse reads body.aweme_detail, null when absent", () => {
    expect(normalizeSingleVideoResponse({ aweme_detail: VIDEO_AWEME })?.id).toBe(
      "7649569886871522573",
    );
    expect(normalizeSingleVideoResponse({ success: true })).toBeNull();
  });
});

// ---- Provider endpoint/cursor/credit mapping (Task 2 — mock the HTTP layer) ----
const tiktokFetch = vi.fn();
vi.mock("$lib/sources/tiktok/server/http.js", () => ({
  tiktokFetch: (...args: unknown[]): unknown => tiktokFetch(...args),
}));

const { scrapeCreatorsTikTokProvider } =
  await import("$lib/sources/tiktok/server/provider/scrapecreators-tiktok.js");

function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

describe("scrapeCreatorsTikTokProvider (endpoint + credit mapping)", () => {
  beforeEach(() => {
    tiktokFetch.mockReset();
  });

  it("[10-03] fetchPosts hits /v3/tiktok/profile/videos and maps creditsUsed/endOfFeed", async () => {
    tiktokFetch.mockResolvedValueOnce(
      jsonResponse({ aweme_list: [VIDEO_AWEME], max_cursor: 999, has_more: 1 }),
    );
    const page = await scrapeCreatorsTikTokProvider.fetchPosts("tiktok", "stoolpresidente", null, {
      origin: "user",
    });
    const calledUrl = tiktokFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/v3/tiktok/profile/videos");
    expect(calledUrl.searchParams.get("handle")).toBe("stoolpresidente");
    expect(calledUrl.searchParams.get("sort_by")).toBe("latest");
    expect(page.creditsUsed).toBe(1);
    expect(page.nextCursor).toBe("999");
    expect(page.endOfFeed).toBe(false);
  });

  it("[10-03] fetchPosts threads a non-null cursor as max_cursor", async () => {
    tiktokFetch.mockResolvedValueOnce(
      jsonResponse({ aweme_list: [], max_cursor: null, has_more: 0 }),
    );
    await scrapeCreatorsTikTokProvider.fetchPosts("tiktok", "h", "12345", { origin: "cron" });
    const calledUrl = tiktokFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.searchParams.get("max_cursor")).toBe("12345");
  });

  it("[10-03] resolveAccount hits /v1/tiktok/profile and returns null for the missing-handle body", async () => {
    tiktokFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, error: "Account doesn't exist" }),
    );
    const result = await scrapeCreatorsTikTokProvider.resolveAccount("tiktok", "ghost");
    const calledUrl = tiktokFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/v1/tiktok/profile");
    expect(result).toBeNull();
  });

  it("[10-03] fetchPostByUrl hits /v2/tiktok/video and maps shares through", async () => {
    tiktokFetch.mockResolvedValueOnce(jsonResponse({ aweme_detail: VIDEO_AWEME }));
    const single = await scrapeCreatorsTikTokProvider.fetchPostByUrl(
      "tiktok",
      "https://www.tiktok.com/@stoolpresidente/video/7649569886871522573",
      { origin: "user" },
    );
    const calledUrl = tiktokFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/v2/tiktok/video");
    expect(single?.metrics.shares).toBe(4974);
  });
});

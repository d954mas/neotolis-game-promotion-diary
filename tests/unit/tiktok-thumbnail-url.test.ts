import { describe, it, expect } from "vitest";
import {
  deriveThumbnailUrl,
  type CardEventLite,
} from "../../src/lib/components/feed/parts/derive-card-data.js";

// deriveThumbnailUrl for tiktok_post must point at the same-origin proxy
// (10-SPIKE.md Q3 RESOLVED at Plan 05 UAT: the TikTok CDN cover hotlinks BLOCKED
// in a real browser, net::ERR_BLOCKED_BY_ORB → raw hotlink fails, mirroring IG's
// CORP block #69) and version the URL by the latest poll timestamp so Refresh-Now
// (or any re-poll) busts the browser cache and the fresh cover appears, while
// serving from cache between polls.

const base: CardEventLite = {
  id: "e1",
  kind: "tiktok_post",
  gameIds: [],
  externalId: "7649569886871522573",
  metadata: null,
  occurredAt: new Date("2026-06-03T08:00:00Z"),
  authorIsMe: false,
  title: "t",
  notes: null,
  url: null,
  sourceId: null,
  lastPolledAt: null,
  lastPollStatus: null,
};

describe("deriveThumbnailUrl — tiktok proxy + cache-buster (Q3 RESOLVED)", () => {
  it("returns the same-origin proxy URL versioned by the latest poll timestamp", () => {
    const polledAt = new Date("2026-06-12T04:41:00Z");
    const url = deriveThumbnailUrl({
      ...base,
      tiktokEnrichment: {
        stats: { viewCount: 1200, likeCount: 3, commentCount: 0, shareCount: 9, polledAt },
        thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
        mediaType: "short",
      },
    });
    expect(url).toBe(`/api/tiktok/thumbnail/7649569886871522573?v=${polledAt.getTime()}`);
  });

  it("omits the ?v cache-buster when there is no snapshot yet", () => {
    const url = deriveThumbnailUrl({
      ...base,
      tiktokEnrichment: {
        stats: null,
        thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
        mediaType: "carousel",
      },
    });
    expect(url).toBe("/api/tiktok/thumbnail/7649569886871522573");
  });

  it("returns null when there is no cached thumbnail", () => {
    const url = deriveThumbnailUrl({
      ...base,
      tiktokEnrichment: { stats: null, thumbnailUrl: null, mediaType: null },
    });
    expect(url).toBeNull();
  });

  it("returns null when the event has no externalId (cannot key the proxy)", () => {
    const url = deriveThumbnailUrl({
      ...base,
      externalId: null,
      tiktokEnrichment: {
        stats: null,
        thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
        mediaType: "short",
      },
    });
    expect(url).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  deriveThumbnailUrl,
  type CardEventLite,
} from "../../src/lib/components/feed/parts/derive-card-data.js";

// deriveThumbnailUrl for instagram_post must point at the same-origin proxy
// (IG's CDN sends CORP: same-origin → raw hotlink blocked, #69) and version the
// URL by the latest poll timestamp so Refresh-Now (or any re-poll) busts the
// browser cache and the fresh cover appears, while serving from cache between
// polls.

const base: CardEventLite = {
  id: "e1",
  kind: "instagram_post",
  gameIds: [],
  externalId: "111_222",
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

describe("deriveThumbnailUrl — instagram proxy + cache-buster (#69)", () => {
  it("returns the same-origin proxy URL versioned by the latest poll timestamp", () => {
    const polledAt = new Date("2026-06-07T04:41:00Z");
    const url = deriveThumbnailUrl({
      ...base,
      instagramEnrichment: {
        stats: { viewCount: null, likeCount: 3, commentCount: 0, polledAt },
        thumbnailUrl: "https://scontent.cdninstagram.com/v/x.jpg",
        mediaType: "carousel",
      },
    });
    expect(url).toBe(`/api/instagram/thumbnail/111_222?v=${polledAt.getTime()}`);
  });

  it("omits the ?v cache-buster when there is no snapshot yet", () => {
    const url = deriveThumbnailUrl({
      ...base,
      instagramEnrichment: {
        stats: null,
        thumbnailUrl: "https://scontent.cdninstagram.com/v/x.jpg",
        mediaType: "image",
      },
    });
    expect(url).toBe("/api/instagram/thumbnail/111_222");
  });

  it("returns null when there is no cached thumbnail", () => {
    const url = deriveThumbnailUrl({
      ...base,
      instagramEnrichment: { stats: null, thumbnailUrl: null, mediaType: null },
    });
    expect(url).toBeNull();
  });

  it("returns null when the event has no externalId (cannot key the proxy)", () => {
    const url = deriveThumbnailUrl({
      ...base,
      externalId: null,
      instagramEnrichment: {
        stats: null,
        thumbnailUrl: "https://scontent.cdninstagram.com/v/x.jpg",
        mediaType: "image",
      },
    });
    expect(url).toBeNull();
  });
});

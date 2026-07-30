import { describe, it, expect } from "vitest";
import {
  deriveThumbnailUrl,
  type CardEventLite,
} from "../../src/lib/components/feed/parts/derive-card-data.js";

// deriveThumbnailUrl (the FeedCard + event-detail-modal resolver) for twitter_post must
// read the enrichment thumbnail — the RAW pbs.twimg.com cover HOTLINKED directly (no
// proxy, 11-SPIKE.md Q6) — NOT event.metadata. The bug: the twitter_post arm read the
// media url off event.metadata, so the feed card + chart marker (which read
// twitterEnrichment) showed the image but the event-detail modal (which also calls
// deriveThumbnailUrl) rendered blank. The fix routes through the enrichment seam, the
// same D-09 parity Telegram/IG/TikTok established.

const base: CardEventLite = {
  id: "e1",
  kind: "twitter_post",
  gameIds: [],
  externalId: "1855555555555555555",
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

describe("deriveThumbnailUrl — twitter/telegram read the enrichment thumbnail (detail-modal parity)", () => {
  it("twitter_post returns the raw pbs.twimg.com hotlink from twitterEnrichment", () => {
    const url = "https://pbs.twimg.com/media/abc.jpg";
    const out = deriveThumbnailUrl({
      ...base,
      twitterEnrichment: { stats: null, thumbnailUrl: url, mediaType: "image" },
    });
    expect(out).toBe(url);
  });

  it("twitter_post IGNORES a stale metadata.media.url (the seam, not metadata)", () => {
    const out = deriveThumbnailUrl({
      ...base,
      metadata: { media: { url: "https://example.com/stale.jpg" } },
      twitterEnrichment: { stats: null, thumbnailUrl: null, mediaType: "text" },
    });
    expect(out).toBeNull();
  });

  it("twitter_post with no enrichment returns null (text-only tweet)", () => {
    expect(deriveThumbnailUrl({ ...base })).toBeNull();
  });

  it("telegram_post returns the telegramEnrichment thumbnail (same fix)", () => {
    const url = "https://cdn4.cdn-telegram.org/file/abc.jpg";
    const out = deriveThumbnailUrl({
      ...base,
      kind: "telegram_post",
      externalId: "chan/42",
      telegramEnrichment: {
        stats: null,
        thumbnailUrl: url,
        mediaKind: "photo",
        reactionsTop: null,
      },
    });
    expect(out).toBe(url);
  });

  it("telegram_post IGNORES a stale metadata.media.url", () => {
    const out = deriveThumbnailUrl({
      ...base,
      kind: "telegram_post",
      externalId: "chan/42",
      metadata: { media: { url: "https://example.com/stale.jpg" } },
      telegramEnrichment: { stats: null, thumbnailUrl: null, mediaKind: null, reactionsTop: null },
    });
    expect(out).toBeNull();
  });
});

// Guards the games-chart event-marker thumbnail resolver (Phase 10 D-09).
//
// The bug: eventThumbnail (wishlist-chart-shared.ts) resolved the telegram_post
// marker thumbnail from event.metadata — but the Telegram feed-enrichment hangs
// the fresh t.me hotlink on telegramEnrichment.thumbnailUrl (NOT metadata), and
// telegramEnrichment wasn't even in the ThumbnailEvent type. So every Telegram
// marker on /games/[id] showed a blank placeholder.
//
// The fix routes the social kinds through their enrichment object — the SAME
// source deriveThumbnailUrl (the FeedCard's resolver) reads — so a marker shows
// the SAME preview the card does. This test pins each kind's resolution path:
// telegram + instagram via enrichment, youtube via the intrinsic CDN URL, and a
// bare event (no enrichment, no externalId) → null. tiktok_post routes through
// the same-origin proxy /api/tiktok/thumbnail/<awemeId> (10-SPIKE.md Q3 RESOLVED
// at Plan 05 UAT: the cover hotlinks ORB-blocked in a real browser), keyed +
// ?v=-versioned exactly like the card's deriveThumbnailUrl.

import { describe, it, expect } from "vitest";
import { eventThumbnail } from "../../src/lib/components/charts/wishlist-chart-shared.js";

// eventThumbnail takes a structurally-typed input (it consumes EventDto-shaped
// rows the games loader ran through adapter.enrichFeedDtos). Build minimal
// fixtures matching that shape per kind.
type ThumbnailEventLike = Parameters<typeof eventThumbnail>[0];

function evt(partial: Partial<ThumbnailEventLike> & { kind: string }): ThumbnailEventLike {
  return {
    externalId: null,
    metadata: null,
    ...partial,
  } as ThumbnailEventLike;
}

describe("eventThumbnail resolves through the adapter enrichment seam (D-09)", () => {
  it("telegram_post returns the telegramEnrichment thumbnail (the FIX — was blank)", () => {
    const url = "https://cdn4.cdn-telegram.org/file/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "telegram_post",
        externalId: "chan/42",
        telegramEnrichment: { thumbnailUrl: url },
      }),
    );
    expect(out).toBe(url);
  });

  it("telegram_post with no enrichment thumbnail returns null (no stale metadata read)", () => {
    const out = eventThumbnail(
      evt({
        kind: "telegram_post",
        externalId: "chan/42",
        // A metadata.media.url that would have been (wrongly) read by the old
        // per-kind branch — the seam-routed resolver must IGNORE it.
        metadata: { media: { url: "https://example.com/stale.jpg" } },
        telegramEnrichment: { thumbnailUrl: null },
      }),
    );
    expect(out).toBeNull();
  });

  it("instagram_post returns the instagramEnrichment thumbnail (unchanged, via the seam)", () => {
    const url = "https://scontent.cdninstagram.com/v/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "instagram_post",
        externalId: "ig123",
        instagramEnrichment: { thumbnailUrl: url },
      }),
    );
    expect(out).toBe(url);
  });

  it("tiktok_post returns the same-origin proxy path keyed by the aweme id (Q3 RESOLVED — cover ORB-blocked)", () => {
    // 10-SPIKE.md Q3 RESOLVED at Plan 05 UAT: the TikTok CDN cover hotlinks
    // BLOCKED in a real browser (net::ERR_BLOCKED_BY_ORB), so the chart marker —
    // like the card — must route through /api/tiktok/thumbnail/<awemeId>, NOT the
    // raw enrichment URL. The marker uses the SAME seam the FeedCard's
    // deriveThumbnailUrl does, so a TikTok marker shows the same preview the card
    // does instead of rendering blank.
    const url = "https://p16.tiktokcdn.com/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "tiktok_post",
        externalId: "tt987",
        tiktokEnrichment: { thumbnailUrl: url },
      }),
    );
    expect(out).toBe("/api/tiktok/thumbnail/tt987");
  });

  it("tiktok_post versions the proxy URL by the latest poll timestamp (?v=) when a snapshot exists", () => {
    const polledAt = new Date("2026-06-12T04:41:00Z");
    const out = eventThumbnail(
      evt({
        kind: "tiktok_post",
        externalId: "tt987",
        tiktokEnrichment: {
          thumbnailUrl: "https://p16.tiktokcdn-us.com/abc.awebp",
          stats: { polledAt },
        },
      }),
    );
    expect(out).toBe(`/api/tiktok/thumbnail/tt987?v=${polledAt.getTime()}`);
  });

  it("tiktok_post with no cached thumbnail returns null (placeholder fallback)", () => {
    expect(
      eventThumbnail(
        evt({ kind: "tiktok_post", externalId: "tt987", tiktokEnrichment: { thumbnailUrl: null } }),
      ),
    ).toBeNull();
  });

  it("twitter_post returns the twitterEnrichment thumbnail — the raw pbs.twimg.com hotlink (Phase 11 D-09)", () => {
    // Phase 11: Twitter now has an enrichment object (twitterEnrichment); the chart
    // marker reads twitterEnrichment.thumbnailUrl (the RAW pbs.twimg.com cover
    // hotlinked directly — NO proxy, 11-SPIKE.md Q6), the SAME source the feed card
    // reads, so the marker stays in sync with the card. The old metadata.media.url
    // branch is gone (the D-09 enrichment-seam parity Telegram/IG/TikTok established).
    const url = "https://pbs.twimg.com/media/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "twitter_post",
        externalId: "tw555",
        twitterEnrichment: { thumbnailUrl: url },
      }),
    );
    expect(out).toBe(url);
  });

  it("twitter_post with no enrichment thumbnail returns null (no stale metadata read)", () => {
    // A null enrichment thumbnail (text-only tweet) → null; a stale metadata.media.url
    // must be IGNORED by the seam-routed resolver (the D-09 parity Telegram has).
    expect(eventThumbnail(evt({ kind: "twitter_post", metadata: null }))).toBeNull();
    expect(
      eventThumbnail(
        evt({
          kind: "twitter_post",
          metadata: { media: { url: "https://example.com/stale.jpg" } },
          twitterEnrichment: { thumbnailUrl: null },
        }),
      ),
    ).toBeNull();
  });

  it("youtube_video returns the intrinsic img.youtube.com URL (no enrichment needed)", () => {
    const out = eventThumbnail(evt({ kind: "youtube_video", externalId: "dQw4w9WgXcQ" }));
    expect(out).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  });

  it("youtube_video with no externalId returns null", () => {
    expect(eventThumbnail(evt({ kind: "youtube_video", externalId: null }))).toBeNull();
  });

  it("a bare event (no enrichment, no externalId) returns null (placeholder fallback)", () => {
    expect(eventThumbnail(evt({ kind: "telegram_post" }))).toBeNull();
    expect(eventThumbnail(evt({ kind: "instagram_post" }))).toBeNull();
    expect(eventThumbnail(evt({ kind: "tiktok_post" }))).toBeNull();
    expect(eventThumbnail(evt({ kind: "twitter_post" }))).toBeNull();
    expect(eventThumbnail(evt({ kind: "post" }))).toBeNull();
  });
});

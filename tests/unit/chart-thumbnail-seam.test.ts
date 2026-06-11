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
// bare event (no enrichment, no externalId) → null. tiktok_post is wired for
// free (its enrichment field lights the marker the moment Plan 04/05 ships).

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

  it("tiktok_post returns the tiktokEnrichment thumbnail (wired for free for Plan 04/05)", () => {
    const url = "https://p16.tiktokcdn.com/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "tiktok_post",
        externalId: "tt987",
        tiktokEnrichment: { thumbnailUrl: url },
      }),
    );
    expect(out).toBe(url);
  });

  it("twitter_post returns the metadata.media.url thumbnail (restored — derive-card-data still serves it)", () => {
    // Twitter has no enrichment object; its thumbnail lives on metadata.media.url
    // (the same chain the card renders via derive-card-data.ts). The D-09 refactor
    // dropped this branch, blanking every twitter marker on /games/[id]; restoring
    // it keeps the chart marker in sync with the card.
    const url = "https://pbs.twimg.com/media/abc.jpg";
    const out = eventThumbnail(
      evt({
        kind: "twitter_post",
        externalId: "tw555",
        metadata: { media: { url } },
      }),
    );
    expect(out).toBe(url);
  });

  it("twitter_post with no metadata.media.url returns null (placeholder fallback)", () => {
    expect(eventThumbnail(evt({ kind: "twitter_post", metadata: null }))).toBeNull();
    expect(eventThumbnail(evt({ kind: "twitter_post", metadata: { media: {} } }))).toBeNull();
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

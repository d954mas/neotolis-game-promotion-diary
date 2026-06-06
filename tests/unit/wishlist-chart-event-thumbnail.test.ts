/**
 * Unit regression for the game-chart event-marker thumbnail resolver
 * (wishlist-chart-shared.ts eventThumbnail) — VIZ-05 Phase 08 UAT gap E.
 *
 * The wishlist-correlation / growth charts render an event marker per
 * event-day; a marker shows the event's preview thumbnail when one is
 * derivable, else a kind-colored placeholder. Pre-fix the resolver handled
 * youtube_video / reddit_post / twitter_post / telegram_post but NOT
 * instagram_post — so an IG marker silently fell through to the placeholder
 * even though the games loader's enrichFeedDtos had already attached the fresh
 * IG CDN hotlink under instagramEnrichment.thumbnailUrl (the SAME source the
 * FeedCard + deriveThumbnailUrl read).
 *
 * Asserts the ACTUAL exported resolver, not a copy.
 */

import { describe, it, expect } from "vitest";
import { eventThumbnail } from "../../src/lib/components/charts/wishlist-chart-shared.js";

describe("eventThumbnail — instagram_post marker preview (Phase 08 UAT gap E)", () => {
  it("returns the IG enrichment thumbnail for an instagram_post event", () => {
    const url = "https://scontent.cdninstagram.com/v/t51.2885-15/abc.jpg";
    const out = eventThumbnail({
      kind: "instagram_post",
      externalId: "Cabc123",
      metadata: null,
      instagramEnrichment: { thumbnailUrl: url },
    });
    expect(out).toBe(url);
  });

  it("returns null for an instagram_post with no enrichment thumbnail (placeholder fallback)", () => {
    expect(
      eventThumbnail({
        kind: "instagram_post",
        externalId: "Cabc123",
        metadata: null,
        instagramEnrichment: { thumbnailUrl: null },
      }),
    ).toBeNull();
    // Missing enrichment object entirely (worker hasn't resolved the post yet).
    expect(
      eventThumbnail({ kind: "instagram_post", externalId: "Cabc123", metadata: null }),
    ).toBeNull();
  });

  it("still resolves youtube_video from its intrinsic id (no regression)", () => {
    expect(eventThumbnail({ kind: "youtube_video", externalId: "vid123", metadata: null })).toBe(
      "https://img.youtube.com/vi/vid123/mqdefault.jpg",
    );
  });
});

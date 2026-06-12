// Twitter/X tweet -> NormalizedPost normalizer (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-02 flips these to live `it(...)` when it
// lands the normalizer. The behaviors are stated here so the implementing plan's
// surface is fixed before the code exists (Phase 2.1/8/9/10 Wave-0 convention).
//
// Requirements: PLAT-03 (D-04 filter, D-05 raw-component retention).
import { describe, it } from "vitest";

describe("twitter normalizer", () => {
  describe("tweet -> NormalizedPost", () => {
    it.skip("[11-02] maps shares = retweetCount + quoteCount (the derived PLAT-03 metric)", () => {});

    it.skip("[11-02] retains the raw retweet_count / quote_count / bookmark_count components (D-05)", () => {});

    it.skip("[11-02] maps view->impressions, comment->replies, like->favorites", () => {});

    it.skip("[11-02] metrics-by-presence: a metric whose field is absent is null, never 0", () => {});

    it.skip("[11-02] both retweet and quote absent -> shares is null (not 0)", () => {});

    it.skip("[11-02] media_type = 'video' for a native-video tweet, 'other' for text/image (D-06)", () => {});
  });

  describe("D-04 timeline filter", () => {
    it.skip("[11-02] keeps original tweets authored by the account", () => {});

    it.skip("[11-02] keeps quote tweets (the account's own commentary)", () => {});

    it.skip("[11-02] keeps self-replies (a thread the account wrote)", () => {});

    it.skip("[11-02] drops pure retweets (no original authored content)", () => {});

    it.skip("[11-02] drops replies to other accounts", () => {});
  });

  describe("single-tweet -> NormalizedSinglePost (paste/preview path)", () => {
    it.skip("[11-02] maps a single fetched tweet to NormalizedSinglePost incl. derived shares", () => {});
  });
});

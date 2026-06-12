// Twitter/X backfill bounds (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. The walker stops at
// SOCIAL_BACKFILL_MAX_POSTS OR the date window, whichever comes first, so cost is
// bounded regardless of archive size (mirrors the TikTok/IG backfill bound).
//
// Requirements: BACK-01 / BACK-02.
import { describe, it } from "vitest";

describe("twitter backfill bound", () => {
  it.skip("[11-03] stops at SOCIAL_BACKFILL_MAX_POSTS (BACK-01)", () => {});

  it.skip("[11-03] stops at the backfill date window (BACK-02)", () => {});

  it.skip("[11-03] marks backfill_complete when the feed is exhausted before the cap", () => {});
});

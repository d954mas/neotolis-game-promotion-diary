// Twitter/X incremental (new-only) backfill (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. After a complete
// backfill, subsequent ticks fetch new tweets only (mirrors the TikTok/IG
// incremental flow off the resumable frontier).
//
// Requirements: BACK-03.
import { describe, it } from "vitest";

describe("twitter incremental backfill", () => {
  it.skip("[11-03] after backfill_complete, a tick fetches only tweets newer than the frontier (BACK-03)", () => {});

  it.skip("[11-03] no new tweets -> no new events, no wasted credit", () => {});
});

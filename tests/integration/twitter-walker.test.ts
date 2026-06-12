// Twitter/X single-feed walker (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. Mirrors the TikTok
// walker integration test (single-feed resumable walk -> events + snapshots).
//
// Requirements: PLAT-03 / BACK-01..03.
import { describe, it } from "vitest";

describe("twitter walker", () => {
  it.skip("[11-03] a single-feed walk inserts events + snapshots with share_count populated", () => {});

  it.skip("[11-03] snapshot rows carry the D-05 raw retweet/quote/bookmark components", () => {});

  it.skip("[11-03] re-walking the same feed is idempotent (pre-INSERT SELECT, no dup events)", () => {});

  it.skip("[11-03] the walker advances the frontier so the next tick resumes where it stopped", () => {});
});

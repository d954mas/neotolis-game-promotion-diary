// Twitter/X warm-lane eligibility (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. The warm scheduler
// selects tweets younger than TWITTER_WARM_WINDOW_DAYS that have gone stale past
// TWITTER_WARM_STALENESS_HOURS, capped by TWITTER_WARM_MAX_FAILURES (mirrors the
// TikTok/IG warm-lane factory).
//
// Requirements: TWITTER_WARM_* envelope.
import { describe, it } from "vitest";

describe("twitter warm-lane eligibility", () => {
  it.skip("[11-03] selects tweets within TWITTER_WARM_WINDOW_DAYS that are stale past TWITTER_WARM_STALENESS_HOURS", () => {});

  it.skip("[11-03] excludes tweets older than the warm window (frozen — manual refresh only)", () => {});

  it.skip("[11-03] excludes tweets at TWITTER_WARM_MAX_FAILURES (stop burning credit on a dead tweet)", () => {});

  it.skip("[11-03] the 26h staleness exceeds the 24h free poll interval so page-1 tweets do not double-pay", () => {});
});

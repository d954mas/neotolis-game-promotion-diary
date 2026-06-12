// Twitter/X not-configured graceful degrade (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-04 flips these live. With TWITTER_PROVIDER
// unset, the adapter degrades: createSource returns kind_not_configured (422) and
// getSocialProvider("twitter") returns null (mirrors the TikTok/IG SOC-05 degrade).
//
// Requirements: SOC-05 / success-criterion #4.
import { describe, it } from "vitest";

describe("twitter not configured (SOC-05 degrade)", () => {
  it.skip("[11-04] TWITTER_PROVIDER unset -> createSource returns kind_not_configured 422", () => {});

  it.skip("[11-04] TWITTER_PROVIDER unset -> getSocialProvider('twitter') returns null", () => {});

  it.skip("[11-04] boot succeeds with TWITTER_PROVIDER unset (self-host parity)", () => {});
});

// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-03.
// Requirements: BUDGET-01, BUDGET-02.
//
// Operator prepaid-credit budget: reserve-before-HTTP, 80/95 throttle lanes,
// and the prepaid balance as the absolute hard ceiling that does NOT reset at
// the daily-cap reset (D-16 / Pitfall 3). Mirrors the YouTube quota model with
// retargeted (prepaid-credit) semantics. Integration test — real Postgres via
// ./helpers.js; provider seam mocked.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("social provider budget + throttle (prepaid credits)", () => {
  it.skip("spend is reserved before the HTTP call (reserve-before-fetch)", async () => {
    // Plan 03: the credit counter increments in the FOR-UPDATE reservation
    // before the provider request, mirroring reserveYoutubeQuota.
  });

  it.skip("80% pauses non-essential lanes, 95% pauses all but user refresh-now", async () => {
    // Plan 03: getThrottleState worst-of across (platform,provider) — eighty
    // skips auto-import + cold re-poll + backfill; ninetyfive skips all but
    // user refresh-now.
  });

  it.skip("prepaid balance is the hard ceiling and does NOT reset at the daily-cap reset", async () => {
    // Plan 03: the quota_reset cron clears only the daily-cap counter; the
    // prepaid balance is monotonically decremented and never refilled by cron.
  });
});

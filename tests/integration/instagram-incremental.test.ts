// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-05.
// Requirements: BACK-03.
//
// After backfill_complete, ongoing refresh fetches only NEW posts since the
// last poll + re-polls metrics of still-active posts — it does NOT walk
// deeper (going deeper requires explicit target expansion). Integration test
// — real Postgres via ./helpers.js; provider seam mocked.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("instagram incremental refresh (post-backfill_complete)", () => {
  it.skip("after backfill_complete, ongoing refresh fetches only new posts since last poll and does not walk deeper", async () => {
    // Plan 05: a completed source's incremental tick fetches page 1 only,
    // imports posts newer than the frontier, and never advances the
    // backfill cursor deeper into history.
  });
});

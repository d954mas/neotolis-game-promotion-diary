// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-05.
// Requirements: BACK-01.
//
// Bounded backfill: the walker stops at SOCIAL_BACKFILL_MAX_POSTS (default 48)
// OR the date window, whichever first — cost is independent of archive size.
// Integration test — real Postgres via ./helpers.js; provider seam mocked.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("instagram backfill bounding (post-count cap + date window)", () => {
  it.skip("walker stops at SOCIAL_BACKFILL_MAX_POSTS cap", async () => {
    // Plan 05: feed > cap posts; assert the walk halts at the cap and
    // sets backfill_complete even though more_available is still true.
  });

  it.skip("walker stops at the date window, whichever bound is hit first", async () => {
    // Plan 05: posts older than SOCIAL_BACKFILL_WINDOW_DAYS are not imported;
    // the walk stops at the window even before the post-count cap.
  });
});

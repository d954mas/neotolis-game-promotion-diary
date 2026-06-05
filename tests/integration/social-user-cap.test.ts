// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-03 / 08-06.
// Requirements: QUOTA-03.
//
// Per-user fair-share cap (LIMIT_SOCIAL_REQUESTS_PER_DAY, default 50): a user
// who exhausts the cap gets 429 via enforceAdapterUserQuota; backfill
// continuation pages run on the cron pool, NOT the per-user cap (the user pays
// the cap once per user-initiated action — Pitfall 5). Integration test —
// real Postgres via ./helpers.js; provider seam mocked.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("social per-user request cap (QUOTA-03)", () => {
  it.skip("per-user 50/day cap returns 429 via enforceAdapterUserQuota", async () => {
    // Plan 03/06: the (N+1)th user-initiated social request in a Pacific day
    // is rejected with 429 via the existing graceful per-user-quota path.
  });

  it.skip("backfill continuation pages run on the cron pool, not the per-user cap", async () => {
    // Plan 03: the trigger click charges the user cap once; subsequent walker
    // pages run uncapped on the operator/cron pool (D-17, Pitfall 5).
  });
});

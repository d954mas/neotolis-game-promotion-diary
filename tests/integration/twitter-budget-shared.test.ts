// Twitter/X provider budget isolation (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. twitterapi.io is a
// SEPARATE prepaid balance from ScrapeCreators (D-02): Twitter spend draws the
// twitterapi.io provider balance row; IG/TikTok spend does NOT reduce it (the
// per-provider social_provider_balance re-key from Plan 10-01). Same shared
// SOCIAL_PROVIDER_* cap envelope, separate balance ledger per provider.
//
// Requirements: BUDGET-01 / D-02.
import { describe, it } from "vitest";

describe("twitter provider budget isolation", () => {
  it.skip("[11-03] spend via the twitter adapter draws from the twitterapi.io provider balance row", () => {});

  it.skip("[11-03] instagram/tiktok (scrapecreators) spend does NOT reduce the twitterapi.io balance (D-02)", () => {});

  it.skip("[11-03] twitter spend reuses the shared SOCIAL_PROVIDER_* daily-cap envelope (no new budget vars)", () => {});
});

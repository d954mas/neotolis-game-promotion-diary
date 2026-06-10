// TikTok shared-ceiling, end-to-end THROUGH THE TIKTOK ADAPTER spend path:
// spend on the instagram platform reduces TikTok's available balance because the
// prepaid balance is one shared pool per provider (D-01). The SCHEMA-level
// invariant is already proven LIVE by
// tests/integration/social-budget-provider-keyed.test.ts (Plan 10-01 Task 1);
// THIS scaffold proves the TikTok adapter's actual reserve path wires into that
// shared balance.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04,
// the TikTok walker/spend path) flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok shared budget ceiling (D-01) — Wave-0 scaffold", () => {
  it.skip(
    "[10-04] an instagram-platform reserve reduces the balance the TikTok adapter's reserve sees (shared ceiling, end-to-end)",
  );
  it.skip(
    "[10-04] an exhausted shared prepaid balance pauses the TikTok walker (operator-issue) even with daily cap headroom",
  );
});

// TikTok operator_paused producer (BUDGET-01) — the walker flips
// metadata.operator_paused on the per-account channel-state row when a tick is
// paused on an exhausted shared prepaid budget, and clears it on a successful
// unpaused tick; the reader overlays it onto each TikTok event DTO so the
// PollingBadge lights up (mirrors the IG operator-paused test).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok operator_paused producer (BUDGET-01) — Wave-0 scaffold", () => {
  it.skip(
    "[10-04] a budget-paused tick SETS metadata.operator_paused on the consumer's tiktok_post event",
  );
  it.skip("[10-04] a restored (unpaused) tick CLEARS operator_paused so the badge is not sticky");
});

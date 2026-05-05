// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-04.
// Phase 02.2 quota counter (events_per_day) was authored before
// auto-import existed. CONTEXT DV-5: the rate cap counts MANUAL pastes
// only (source_id IS NULL). Auto-import flows must bypass withQuotaGuard
// entirely so a registered channel doesn't count against the
// human-time-budget envelope the cap models.
import { describe, it } from "vitest";

describe("quota events_per_day source_id filter (Plan 03.0-04, DV-5)", () => {
  it.skip("currentCount('events_per_day') filters source_id IS NULL — activated in Plan 03.0-04", () => {});
  it.skip("auto-import paths bypass withQuotaGuard entirely (no count consumed) — activated in Plan 03.0-04", () => {});
});

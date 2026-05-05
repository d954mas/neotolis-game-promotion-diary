// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-04.
// CONTEXT DV-5: the events_per_day quota counts manual pastes only
// (source_id IS NULL). Auto-import workers bypass withQuotaGuard so
// a registered YouTube channel posting 50 videos in one day doesn't
// burn the user's manual-paste budget. The cap is a human-time
// envelope, not a database-row envelope.
import { describe, it } from "vitest";

describe("auto-import quota bypass (Plan 03.0-04, DV-5)", () => {
  it.skip("currentCount('events_per_day') excludes events with source_id IS NOT NULL — activated in Plan 03.0-04", () => {});
  it.skip("auto-import worker creating event when user is at 500/day cap → succeeds — activated in Plan 03.0-04", () => {});
  it.skip("manual paste at 500/day cap → 429 quota_exceeded — activated in Plan 03.0-04", () => {});
});

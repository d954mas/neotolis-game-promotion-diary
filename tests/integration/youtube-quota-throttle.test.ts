// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// 80% / 95% throttle gates pause Cold + auto-import / Active polling
// respectively. The audit row that announces the throttle event MUST
// fire ONCE PER DAY at the first crossing — re-emitting on every
// subsequent scheduler tick would flood /admin/quota with noise.
// Idempotency is keyed (date_pacific, api_key_id, threshold).
import { describe, it } from "vitest";

describe("youtube-quota-throttle (Plan 03.0-09)", () => {
  it.skip("8000+ units in single key → scheduler pauses cold + auto-import only — activated in Plan 03.0-09", () => {});
  it.skip("9500+ units in single key → scheduler pauses everything except poll.user — activated in Plan 03.0-09", () => {});
  it.skip("first 80% threshold crossing emits quota.service_throttled audit row once per day — activated in Plan 03.0-09", () => {});
  it.skip("second 80% crossing same day does NOT re-emit — activated in Plan 03.0-09", () => {});
});

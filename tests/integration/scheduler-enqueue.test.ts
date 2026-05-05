// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// Scheduler ticks every 15 min (Active) / hourly (Cold). Frozen and
// Unavailable events MUST NOT be enqueued — the scheduler is the only
// process that decides "is this event due"; workers consume jobs blind.
// This is the load-bearing test for the tier-resolver → enqueue
// indirection (CONTEXT D-12 cron → DB → worker).
import { describe, it } from "vitest";

describe("scheduler enqueue (Plan 03.0-09)", () => {
  it.skip("scheduler tick at Active boundary enqueues to poll.active — activated in Plan 03.0-09", () => {});
  it.skip("scheduler tick at Cold boundary enqueues to poll.cold — activated in Plan 03.0-09", () => {});
  it.skip("scheduler skips Frozen events (no enqueue) — activated in Plan 03.0-09", () => {});
  it.skip("scheduler skips Unavailable events (no enqueue) — activated in Plan 03.0-09", () => {});
});

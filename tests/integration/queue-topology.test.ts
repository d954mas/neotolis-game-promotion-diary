// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// Phase 1 declared 4 poll queues + internal.healthcheck as a forward-
// compat scaffold. Plan 03.0-09 retires POLL_HOT + POLL_WARM (replaced
// by POLL_ACTIVE under the 3-tier model) and ADDS POLL_COLD,
// PURGE_DAILY, YOUTUBE_QUOTA_RESET, YOUTUBE_CHANNEL_CONTEXT_BACKFILL.
// pgboss persists queue declarations in pgboss.queue; this test pins
// the topology so a future executor can't accidentally re-introduce
// hot/warm or drop a Phase 3.0 queue.
import { describe, it } from "vitest";

describe("queue topology (Plan 03.0-09)", () => {
  it.skip("boss has 6 queues declared (POLL_USER, POLL_COLD, INTERNAL_HEALTHCHECK, POLL_ACTIVE, PURGE_DAILY, YOUTUBE_QUOTA_RESET, YOUTUBE_CHANNEL_CONTEXT_BACKFILL) — activated in Plan 03.0-09", () => {});
  it.skip("POLL_HOT and POLL_WARM rows are absent from pgboss.queue post-migrate — activated in Plan 03.0-09", () => {});
});

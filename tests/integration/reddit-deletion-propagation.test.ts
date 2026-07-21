// Wave-0 scaffold — flipped live by Plan 12-05 (deletion-propagation cron,
// Variant A: disappearance-from-walk). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit deletion propagation (D-06 Variant A — Phase 12)", () => {
  it.skip(
    "[12-05] a tracked post that disappears from the walk sets deletion_detected_at (first-detect idempotent)",
  );
  it.skip(
    "[12-05] the daily zero-HTTP purge cron NULLs author/author_fullname after the grace window",
  );
  it.skip(
    "[12-05] the cron writes the reddit.deletion_propagated audit IN-TX (tx.insert, not writeAudit)",
  );
  it.skip("[12-05] title/body excerpt survive the purge (diary context preserved)");
});

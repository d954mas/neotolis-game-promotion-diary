// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// Phase 4 chart-loader contract pin: the per-event detail page reads
// snapshots from youtube_video_snapshots WHERE video_id = e.external_id
// (the snapshot row is tenant-agnostic — public data — but the JOIN
// against events filters by user_id so each tenant only sees the
// snapshot history for events they own). This is the inverse-of-
// tenant-scope-rule case (snapshot rows have no user_id by design;
// privacy is preserved by the JOIN, not by row ownership).
import { describe, it } from "vitest";

describe("youtube snapshot read contract (Plan 03.0-09 — Phase 4 chart-loader handoff)", () => {
  it.skip("Phase 4 chart-loader contract — SELECT snapshots WHERE video_id=e.external_id JOIN events WHERE e.user_id=$1 returns only that user's video snapshots — activated in Plan 03.0-09", () => {});
});

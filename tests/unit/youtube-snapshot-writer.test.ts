// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-04.
// youtube-snapshot-writer issues an idempotent two-phase write (snapshot
// row keyed (video_id, polled_at_minute) — ON CONFLICT DO NOTHING — and
// updates events.last_polled_at) inside a SHORT tx so a 5s mock fetch
// latency upstream cannot hold a row lock.
import { describe, it } from "vitest";

describe("youtube-snapshot-writer (Plan 03.0-04)", () => {
  it.skip("writeSnapshot inserts row with polled_at truncated to minute — activated in Plan 03.0-04", () => {});
  it.skip("writeSnapshot ON CONFLICT DO NOTHING on retry within same minute — activated in Plan 03.0-04", () => {});
  it.skip("writeSnapshot updates events.last_polled_at to now() — activated in Plan 03.0-04", () => {});
  it.skip("writeSnapshot increments youtube_service_quota_usage in same tx — activated in Plan 03.0-04", () => {});
});

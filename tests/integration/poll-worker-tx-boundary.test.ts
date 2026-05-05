// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-09.
// Poll workers fetch from YouTube (slow, network-bound) BEFORE opening
// the snapshot-write tx — never inside it. The tx's ONLY job is the
// idempotent two-phase write (snapshot row + events.last_polled_at +
// quota counter). Holding a row lock during the HTTP fetch is the
// classic anti-pattern that cascades into pool exhaustion under
// transient YouTube latency. This test pins the boundary so a future
// executor can't accidentally inline the fetch.
import { describe, it } from "vitest";

describe("poll worker tx boundary (Plan 03.0-09)", () => {
  it.skip("snapshot write tx duration < 50ms even with 5s mock fetch latency — activated in Plan 03.0-09", () => {});
  it.skip("events row not held in tx during fetch (concurrent SELECT during HTTP call succeeds immediately) — activated in Plan 03.0-09", () => {});
});

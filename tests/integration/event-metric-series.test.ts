import { describe, it } from "vitest";

// VIZ-01 — adapter-driven per-event metric series (D-14). Each source adapter
// exposes `fetchEventMetricSeries(userId, event)` returning ASC-ordered points
// read from its own public-data snapshot table by externalId. YouTube emits
// view/like/comment series; Reddit emits score/num_comments. The tenant
// guarantee comes from the caller's event SELECT (these snapshot tables are
// public-data, in the ESLint allowlist), mirroring `enrichFeedDtos`.
//
// Wave 0 scaffold (Nyquist invariant): named placeholders only — Plan 04-02
// implements the adapter method and activates these. Model the seed/assert on
// tests/integration/youtube-snapshot-read.test.ts and reddit-snapshots.test.ts.
describe("event metric series (VIZ-01)", () => {
  it.skip("youtube adapter fetchEventMetricSeries returns ASC view/like/comment series (Plan 04-02)");

  it.skip("reddit adapter fetchEventMetricSeries returns ASC score/num_comments series (Plan 04-02)");

  it.skip("fewer than 3 snapshots still returns the available points (Plan 04-02 / D-07)");
});

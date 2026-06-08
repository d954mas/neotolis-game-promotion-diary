// Telegram feed + chart visualization — integration tests (real Postgres via
// ./helpers.js).
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// feed/chart assertions from 09-RESEARCH.md §Validation Architecture; the feed
// enrichment + chart series loader (D-05: a view_count=null post still appears
// in the feed but is excluded from fetchEventMetricSeries / the chart) lands in
// Plan 05/06.
//
// Skipped suites pass vacuously so the integration suite stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram feed + chart viz (filled in Plan 05/06)", () => {
  it.skip("a view_count=null post appears in the feed (D-05)");
  it.skip("a view_count=null post is excluded from fetchEventMetricSeries / the chart (D-05)");
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// EventHistoryChart must disable animation (#69 Issue 2).
//
// svelte-echarts' <Chart> applies options with notMerge:true, so EVERY setOption
// (a Refresh-Now invalidateAll re-running the page loader) RESETS the chart and
// replays the entry animation — the "graph redraws from 0 every reload" jank the
// user hit during refresh. Disabling animation on this chart makes a data reload
// update in place (instant). Guard: the chart's options override the shared
// baseChartOptions default with animation:false.

const src = fs.readFileSync(
  path.resolve("src/lib/components/charts/EventHistoryChart.svelte"),
  "utf8",
);

describe("EventHistoryChart animation (#69 Issue 2)", () => {
  it("disables animation so a Refresh-Now data reload doesn't redraw the graph from 0", () => {
    expect(src, "EventHistoryChart options set animation: false").toMatch(/animation:\s*false/);
  });
});

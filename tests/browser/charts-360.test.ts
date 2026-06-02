import { describe, it } from "vitest";

// VIZ-04 — chart reflow + responsive detail surface under 600px.
//
// ECharts paints to canvas (not DOM-introspectable), so these assert the
// wrapper / structure, not chart internals: the container reflows at 360px and
// 600px (D-10 adaptive thinning, no horizontal scroll); the D-02 detail surface
// opens as a bottom-sheet <600px and a right-side drawer >=600px; the low-data
// dots+caption render (D-07); the no-CSV empty-state CTA renders (D-08). Model
// the 360px viewport + preview-server pattern on
// tests/browser/responsive-360.test.ts.
//
// Wave 0 scaffold (Nyquist invariant): named placeholders only — Plan 04-05
// implements the chart components and activates these.
describe("charts at 360px (VIZ-04)", () => {
  it.skip("wishlist correlation chart container reflows at 360px and 600px (Plan 04-05 / VIZ-04)");

  it.skip("marker detail surface opens as bottom-sheet <600px and drawer >=600px (Plan 04-05 / D-02)");

  it.skip("low-data dots+caption render (Plan 04-05 / D-07)");

  it.skip("no-CSV empty-state CTA renders (Plan 04-05 / D-08)");
});

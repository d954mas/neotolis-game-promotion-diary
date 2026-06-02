import { abbreviate } from "./abbreviate.js";

/**
 * Library-agnostic-at-the-edge chart helpers. This is the ONE leaf where
 * ECharts-shaped option objects are assembled (D-06 intent: services stay
 * library-agnostic; only the chart components + this file know about ECharts).
 *
 * Two pitfalls these helpers exist to dodge (RESEARCH 04 Pitfalls 1 & 2):
 *   - SSR: ECharts touches `document`; CSS custom properties are unreadable
 *     inside a canvas. Both `resolveKindColor` and `prefersReducedMotion` are
 *     client-only and guard with `typeof window === "undefined"`.
 *   - `--k-*` tokens (`var(--k-youtube)`) render as empty strings if passed to
 *     a canvas lineStyle; resolve them to concrete hex at option-build time via
 *     getComputedStyle.
 */

/**
 * Resolve a `--k-{kind}` kind token to a concrete hex color at option-build
 * time. `kind` may be a base kind ("youtube", "reddit") or an event-kind
 * interpolation ("youtube_video", "reddit_post") — both have `--k-*` aliases in
 * app.css :root. Unknown / grouped mixed-kind markers fall back to the neutral
 * `--k-post` color (D-04). Client-only: returns "" under SSR (no document).
 */
export function resolveKindColor(kind: string): string {
  if (typeof window === "undefined") return "";
  const root = getComputedStyle(document.documentElement);
  const direct = root.getPropertyValue("--k-" + kind).trim();
  if (direct) return direct;
  return root.getPropertyValue("--k-post").trim();
}

/**
 * Whether the user prefers reduced motion. Chart components pass
 * `animation: !prefersReducedMotion()` into the ECharts option (AGENTS.md:
 * prefers-reduced-motion gates every transition). Client-only.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Shared ECharts option defaults spread by both the VIZ-01 per-event chart and
 * the VIZ-02/03 correlation chart: tight grid margins, axis-trigger tooltip,
 * reduced-motion-gated animation, and the D-11 abbreviated yAxis formatter.
 */
export function baseChartOptions(opts: { reducedMotion: boolean }): object {
  return {
    animation: !opts.reducedMotion,
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category" },
    yAxis: {
      type: "value",
      axisLabel: { formatter: (value: number): string => abbreviate(value) },
    },
  };
}

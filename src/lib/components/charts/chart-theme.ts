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
 * Resolve the brand `--accent` token to a concrete `rgba(r,g,b,alpha)` string at
 * option-build time — for the post-event highlight band on the wishlist line
 * (04-18). The ECharts canvas can't read CSS vars / `color-mix()` (that's the
 * exact bug that rendered the old markArea as a gray square), so getComputedStyle
 * resolves `--accent` to its hex and we splice in the alpha. `--accent` is a hex
 * (`#e89b5e`) in app.css; if a theme ever makes it non-hex we fall back to a
 * neutral so the canvas never receives a string it can't parse. Client-only:
 * returns "" under SSR (no document).
 */
export function resolveAccentRgba(alpha: number): string {
  if (typeof window === "undefined") return "";
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const h = hex.replace(/^#/, "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) return `rgba(232,155,94,${alpha})`;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Whether the user prefers reduced motion. Chart components pass
 * `animation: !prefersReducedMotion()` into the ECharts option (AGENTS.md:
 * prefers-reduced-motion gates every transition). Client-only.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * FIXED horizontal plot geometry shared by BOTH wishlist charts (correlation +
 * growth). Both charts mount the SAME DOM marker overlay, which pixel-clusters
 * event-days via `chart.convertToPixel`. If the two charts used `containLabel:
 * true`, ECharts would size each plot's `left` inset to ITS OWN y-axis label
 * width — the wishlist-balance chart's labels ("12.3k") are wider than the
 * daily-growth chart's ("40") — so a given DATE would map to a DIFFERENT x-pixel
 * on each chart and the overlays would cluster DIFFERENT days (May 13+14 merge
 * on one chart but not the other). Pinning an explicit px `left`/`right` with
 * `containLabel: false` makes a date map to the SAME x-pixel on both → identical
 * clusters/chips/counts/positions. `left` is sized to fit the widest y-axis
 * label across both charts (an abbreviated balance up to ~5 chars like "12.3k").
 */
export const WISHLIST_CHART_GRID = {
  left: 52,
  right: 16,
  // Chip breathing room (04-18): the event chips sit in a top band (~8..48px);
  // a 16px grid.top put the top gridline / "300" label right under the chip row.
  // Push the plot down so the top gridline clears the chips (chip band height +
  // a gap). The shared overlay reads the same grid rect, so both charts agree.
  top: 56,
  bottom: 36,
  containLabel: false,
} as const;

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

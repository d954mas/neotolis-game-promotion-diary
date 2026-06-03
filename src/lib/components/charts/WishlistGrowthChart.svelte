<script lang="ts">
  // WishlistGrowthChart — the SECOND wishlist chart on /games/[gameId] (04-08).
  //
  // The line chart above answers "where are wishlists now?"; this one answers
  // "did this post move the needle THAT day?" — daily NET CHANGE as bars. A tall
  // bar on an event-marker day is the needle moving.
  //
  // Daily growth is DERIVED client-side from the SAME cumulative `points` the
  // correlation chart already uses: growth[i] = balance[i] − balance[i-1], keyed
  // by points[i].date. The import already maintains the immutable cumulative
  // `balance`; subtracting consecutive days is the honest daily delta (never a
  // re-sum of adds−deletes). NO loader/service/DB change.
  //
  // Shared with the correlation chart (04-08 KISS/DRY):
  //   - the SAME date `range` (prop) clips the visible window.
  //   - the SAME per-listing `visible` legend map (prop) hides/shows listings
  //     (driven by the custom <ChartLegend> at the page — no native legend).
  //   - the SAME stable per-listing color (listingColor) so a listing is the
  //     same color on both charts AND on the legend swatch.
  //   - the SAME event markers: the SHARED <ChartMarkerOverlay> (HTML chips +
  //     dashed guide line) — NOT a canvas guide. 04-13 unified the marker
  //     language across both charts: the growth chart's old ECharts canvas guide
  //     was replaced by the same DOM overlay the correlation chart mounts, so a
  //     growth spike lines up with the same chip the line chart shows, clustered
  //     pixel-identically (one buildDayGroups, one overlay — KISS/DRY).
  //
  // Color: per-listing palette is primary (so multiple listings stay
  // distinguishable). When EXACTLY ONE listing is visible, bars additionally
  // sign-color (positive → --success, negative → --danger) — a single-listing
  // nicety that reads "this day gained / lost wishlists" at a glance without
  // ambiguity (with multiple listings, per-listing color wins to keep them
  // separable). Resolved via getComputedStyle, SSR-guarded.
  //
  // SSR (Pitfall 1): the option resolves CSS tokens via getComputedStyle, so
  // it's built client-only and <Chart> is gated on `typeof window`.

  import { Chart } from "svelte-echarts";
  import { init, use } from "echarts/core";
  import type { EChartsType } from "echarts/core";
  import { BarChart } from "echarts/charts";
  import { GridComponent, TooltipComponent } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import { m } from "$lib/paraglide/messages.js";
  import { abbreviate } from "./abbreviate.js";
  import { baseChartOptions, prefersReducedMotion, WISHLIST_CHART_GRID } from "./chart-theme.js";
  import ChartMarkerOverlay from "./ChartMarkerOverlay.svelte";
  import {
    listingColor,
    inRange,
    buildDayGroups,
    axisDomain,
    isoDay,
    tooltipEventsHtml,
    listingLabel as buildListingLabel,
    type ListingLite,
  } from "./wishlist-chart-shared.js";
  import type { EventDto, WishlistSeries } from "$lib/server/dto.js";

  use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

  let {
    seriesByListing,
    events,
    listings,
    range,
    visible,
    onSelectCluster,
  }: {
    /** One wishlist series per active listing, keyed by listing id. */
    seriesByListing: Record<string, WishlistSeries>;
    events: EventDto[];
    /** Active listings (id + display name / appId) — drives bar labels + order. */
    listings: ListingLite[];
    /** Shared date-range (owned by the page) — null = all time. CONTROLLED. */
    range: { from: Date; to: Date } | null;
    /** Shared legend selection (owned by the page): listingId → shown. CONTROLLED.
     *  Bar visibility is driven PURELY by filtering the series on this map (the
     *  custom <ChartLegend> at the page flips it) — no ECharts native legend. */
    visible: Record<string, boolean>;
    /** Marker (cluster) tap → the page (which owns the day-detail modal + feed
     *  data). The shared overlay merges nearby event-days into one chip and
     *  emits ALL the chip's days, so the growth + correlation charts hand the
     *  page the SAME cluster shape (04-13). */
    onSelectCluster: (days: string[]) => void;
  } = $props();

  // The live ECharts instance (svelte-echarts exposes it via `chart = $bindable()`).
  // The HTML marker overlay reads it to pixel-position + cluster the event chips
  // — the SAME overlay the correlation chart mounts (04-13 unified markers).
  let chart = $state<EChartsType | undefined>();

  function listingLabel(l: ListingLite): string {
    return buildListingLabel(
      l,
      (appId) => m.viz_legend_listing_fallback({ appId }),
      () => m.viz_wishlist_line_label(),
    );
  }

  function isVisible(listingId: string): boolean {
    return visible[listingId] !== false;
  }

  // ── Per-listing daily-growth bars (filtered by range + the visible map) ─
  // Each in-range visible listing with >=2 points becomes one bar series of
  // [date, balance[i] − balance[i-1]]. The first bar of a series has no prior
  // day, so growth starts at the SECOND in-range point.
  type Bar = { id: string; label: string; color: string; data: [string, number][] };

  const bars = $derived.by((): Bar[] => {
    return listings
      .filter((l) => isVisible(l.id))
      .map((l): Bar => {
        const s = seriesByListing[l.id] ?? { points: [], lastImportedAt: null };
        const pts = s.points.filter((p) => inRange(p.date, range));
        const data: [string, number][] = [];
        for (let j = 1; j < pts.length; j++) {
          data.push([pts[j]!.date, pts[j]!.balance - pts[j - 1]!.balance]);
        }
        return { id: l.id, label: listingLabel(l), color: listingColor(listings, l.id), data };
      })
      .filter((bar) => bar.data.length > 0);
  });

  const hasData = $derived(bars.length > 0);
  const singleListing = $derived(bars.length === 1);

  // ── Event-day markers (shared with the correlation chart) ────────────
  const dayGroups = $derived(buildDayGroups(events, range));

  // SAME x-axis domain as the correlation chart so markers line up across the
  // two: union of ALL listings' point dates ∪ event days, clamped to range.
  const allPointDates = $derived.by((): string[] => {
    const out: string[] = [];
    for (const id of Object.keys(seriesByListing)) {
      for (const p of seriesByListing[id]!.points) {
        if (inRange(p.date, range)) out.push(p.date);
      }
    }
    return out;
  });
  const domain = $derived(axisDomain(allPointDates, dayGroups, range));

  // A value that changes whenever the chart re-renders the markers' x positions
  // (range window, visible set, day set). The shared overlay reads this to
  // re-run its pixel-cluster layout — same contract as the correlation chart.
  const recomputeKey = $derived(
    JSON.stringify({
      d: domain,
      v: visible,
      bars: bars.map((b) => b.id),
      days: dayGroups.map((g) => g.date),
    }),
  );

  function resolveToken(name: string): string {
    if (typeof window === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ── Crosshair axis tooltip (parity with the correlation chart) ───────
  // The growth chart had no tooltip; add the SAME enriched one so hovering a day
  // (or its dashed line, which dispatches showTip) shows the date + each visible
  // listing's daily CHANGE + that day's events (thumbnail/dot + title). One
  // shared event-rows builder (tooltipEventsHtml) — same as the correlation chart.
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function axisValueToDay(axisValue: unknown): string | null {
    if (typeof axisValue !== "number" && typeof axisValue !== "string") return null;
    const d = new Date(axisValue);
    if (Number.isNaN(d.getTime())) return null;
    return isoDay(d);
  }

  function signed(v: number): string {
    return v > 0 ? `+${abbreviate(v)}` : abbreviate(v);
  }

  const crosshairTooltip = $derived.by(() => ({
    trigger: "axis" as const,
    axisPointer: { type: "line" as const },
    confine: true,
    formatter: (raw: unknown): string => {
      const params = (Array.isArray(raw) ? raw : [raw]) as Array<{
        seriesName?: string;
        color?: string;
        axisValueLabel?: string;
        axisValue?: unknown;
        value?: unknown;
      }>;
      if (params.length === 0) return "";
      const dateLabel = params[0]?.axisValueLabel ?? "";
      const head = `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(String(dateLabel))}</div>`;
      const rows = params
        .map((p) => {
          // value is the [date, dailyChange] tuple for a time-axis bar series.
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          const num = typeof v === "number" ? signed(v) : "—";
          const swatch = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${escapeHtml(String(p.color ?? "#888"))};margin-right:6px;"></span>`;
          return `<div style="display:flex;align-items:center;gap:8px;"><span>${swatch}${escapeHtml(String(p.seriesName ?? ""))}</span><span style="margin-left:auto;font-variant-numeric:tabular-nums;">${escapeHtml(num)}</span></div>`;
        })
        .join("");
      const day = axisValueToDay(params[0]?.axisValue);
      const eventsHtml = day
        ? tooltipEventsHtml(day, dayGroups, (count) => m.viz_marker_more({ count }))
        : "";
      return `<div style="min-width:140px;max-width:260px;">${head}${rows}${eventsHtml}</div>`;
    },
  }));

  // ── Click anywhere on the plot → the nearest event-day's modal ───────
  // Parity with the correlation chart: empty-plot clicks fall through the
  // pointer-events:none overlay to the ZRender canvas → convert x-pixel to a date
  // → nearest event-day → open its modal. Chip/line clicks already emit their own
  // selection and stop at the overlay's buttons. Guard: no event-days → ignore.
  function nearestDay(dateMs: number): string | null {
    if (dayGroups.length === 0) return null;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const g of dayGroups) {
      const t = new Date(`${g.date}T00:00:00`).getTime();
      const dist = Math.abs(t - dateMs);
      if (dist < bestDist) {
        bestDist = dist;
        best = g.date;
      }
    }
    return best;
  }

  $effect(() => {
    const c = chart;
    if (!c) return;
    const onZrClick = (e: { offsetX: number }): void => {
      if (c.isDisposed() || dayGroups.length === 0) return;
      const px = c.convertFromPixel({ xAxisIndex: 0 }, e.offsetX);
      const ms = Array.isArray(px) ? px[0]! : px;
      if (typeof ms !== "number" || Number.isNaN(ms)) return;
      const day = nearestDay(ms);
      if (day) onSelectCluster([day]);
    };
    // Click ANYWHERE on the plot canvas (chips/lines own their own clicks above).
    c.getZr().on("click", onZrClick);
    return () => {
      if (!c.isDisposed()) c.getZr().off("click", onZrClick);
    };
  });

  // ── ECharts option (client-only — resolves CSS tokens) ───────────────
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();
    const okColor = resolveToken("--success");
    const downColor = resolveToken("--danger");

    const barSeries = bars.map((bar) => ({
      name: bar.label,
      type: "bar" as const,
      // Single-listing nicety: sign-color each bar via a PER-DATUM itemStyle
      // (positive → --success, negative → --danger). With multiple listings the
      // per-listing palette color wins so the listings stay separable. Encoding
      // the color on the datum keeps the series itemStyle a plain string (no
      // callback → no ECharts CallbackDataParams typing friction).
      data: singleListing
        ? bar.data.map(([date, v]) => ({
            value: [date, v] as [string, number],
            itemStyle: { color: v >= 0 ? okColor : downColor },
          }))
        : bar.data,
      itemStyle: { color: bar.color },
    }));

    // No bars → a hidden anchor series keeps the grid drawn so the event chips
    // (DOM overlay) sit over a real plot area (parity with the line chart's D-08
    // empty state). The markers themselves are the DOM overlay (no canvas guide).
    const anchorSeries = {
      name: "__growth_anchor__",
      type: "bar" as const,
      data: [] as [string, number][],
    };

    return {
      ...baseChartOptions({ reducedMotion }),
      tooltip: crosshairTooltip,
      // No ECharts native legend — the custom <ChartLegend> at the page drives
      // per-listing visibility via the shared `visible` map (04-09).
      // SAME fixed grid geometry (shared constant) as the correlation chart so a
      // date maps to the SAME x-pixel on both → the two DOM overlays cluster
      // event-days IDENTICALLY (04-14). The narrow growth labels ("40") no longer
      // give this chart a different left inset than the wide-balance chart.
      grid: WISHLIST_CHART_GRID,
      xAxis: {
        type: "time" as const,
        splitNumber: 4,
        axisLabel: { hideOverlap: true },
        // Same domain as the line chart so markers align across both (and
        // off-window event markers render).
        ...(domain ? { min: domain.min, max: domain.max } : {}),
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { formatter: (v: number): string => abbreviate(v) },
      },
      series: barSeries.length > 0 ? barSeries : [anchorSeries],
    };
  });
</script>

<div
  class="wishlist-growth-chart"
  data-testid="wishlist-growth-chart"
  data-low-data={hasData ? "false" : "true"}
  data-bar-count={bars.length}
>
  <!-- Height-reserving wrapper OUTSIDE the typeof-window gate (04-18): keeps the
       slot's 300px height on SSR + before mount so the chart can't jump the
       layout (no CLS); a skeleton fills it until the client chart mounts. -->
  <div class="chart-canvas">
    {#if typeof window !== "undefined"}
      <!-- Relatively-positioned wrapper so the absolutely-positioned HTML marker
           overlay lays its event chips (+ dashed guide lines) OVER the plot area —
           the SAME overlay the correlation chart mounts (04-13 unified markers). -->
      <Chart {init} {options} bind:chart />
      <ChartMarkerOverlay {chart} {dayGroups} {recomputeKey} {onSelectCluster} />
    {/if}
    {#if !chart}
      <!-- Skeleton placeholder: a muted box until the client chart mounts. The
           shimmer is gated off under prefers-reduced-motion (static box only). -->
      <div class="chart-skeleton" data-testid="chart-skeleton" aria-hidden="true"></div>
    {/if}
  </div>

  {#if !hasData}
    <!-- Low/empty (D-07/D-08 parity): a caption, not an empty bar grid. The
         markers still render above when there are events in range. -->
    <p class="growth-low-data">{m.viz_growth_low_data()}</p>
  {/if}
</div>

<style>
  .wishlist-growth-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    width: 100%;
  }
  .chart-canvas {
    position: relative;
    width: 100%;
    /* EQUAL peer of the headline correlation chart — same 300px height (the
     * user: "они оба важные одинаково"). */
    height: 300px;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  /* Loading skeleton (04-18): a muted box filling the reserved chart height
   * until the client chart mounts, so the strip never flashes/jumps on load.
   * Subtle shimmer; disabled under prefers-reduced-motion. */
  .chart-skeleton {
    position: absolute;
    inset: 0;
    border-radius: var(--r-md);
    background: var(--surface-2);
    overflow: hidden;
  }
  .chart-skeleton::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in oklab, var(--surface-3, var(--surface)) 60%, transparent) 50%,
      transparent 100%
    );
    transform: translateX(-100%);
    animation: chart-skeleton-shimmer 1.4s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .chart-skeleton::after {
      animation: none;
    }
  }
  @keyframes chart-skeleton-shimmer {
    100% {
      transform: translateX(100%);
    }
  }
  .growth-low-data {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
  }
</style>

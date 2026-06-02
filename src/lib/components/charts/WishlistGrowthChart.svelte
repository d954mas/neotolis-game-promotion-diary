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
  //   - the SAME event markers (buildDayGroups + buildMarkLineData) so a growth
  //     spike lines up with the post that caused it.
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
  import { BarChart } from "echarts/charts";
  import {
    GridComponent,
    TooltipComponent,
    MarkLineComponent,
  } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import type { ECMouseEvent } from "svelte-echarts";
  import EventMarkerPanel from "./EventMarkerPanel.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { abbreviate } from "./abbreviate.js";
  import { baseChartOptions, prefersReducedMotion } from "./chart-theme.js";
  import {
    listingColor,
    inRange,
    buildDayGroups,
    buildMarkLineData,
    axisDomain,
    listingLabel as buildListingLabel,
    type ListingLite,
  } from "./wishlist-chart-shared.js";
  import type { EventDto, GameDto, DataSourceDto, WishlistSeries } from "$lib/server/dto.js";

  use([
    BarChart,
    GridComponent,
    TooltipComponent,
    MarkLineComponent,
    CanvasRenderer,
  ]);

  let {
    seriesByListing,
    events,
    listings,
    sources,
    games,
    today,
    range,
    visible,
  }: {
    /** One wishlist series per active listing, keyed by listing id. */
    seriesByListing: Record<string, WishlistSeries>;
    events: EventDto[];
    /** Active listings (id + display name / appId) — drives bar labels + order. */
    listings: ListingLite[];
    sources: DataSourceDto[];
    games: GameDto[];
    /** Server-chosen "now" ISO instant (kept for marker-panel parity). */
    today: string;
    /** Shared date-range (owned by the page) — null = all time. CONTROLLED. */
    range: { from: Date; to: Date } | null;
    /** Shared legend selection (owned by the page): listingId → shown. CONTROLLED.
     *  Bar visibility is driven PURELY by filtering the series on this map (the
     *  custom <ChartLegend> at the page flips it) — no ECharts native legend. */
    visible: Record<string, boolean>;
  } = $props();

  void today;

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

  // ── Marker → panel (mirror the correlation chart's click-to-panel) ───
  let selectedDay = $state<string | null>(null);
  const selectedGroup = $derived(
    selectedDay ? (dayGroups.find((g) => g.date === selectedDay) ?? null) : null,
  );
  function closePanel(): void {
    selectedDay = null;
  }
  function onChartClick(e: ECMouseEvent): void {
    if (e.componentType !== "markLine") return;
    const day = (e.data as { name?: string } | undefined)?.name;
    if (typeof day === "string") selectedDay = day;
  }

  function resolveToken(name: string): string {
    if (typeof window === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ── ECharts option (client-only — resolves CSS tokens) ───────────────
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();
    const okColor = resolveToken("--success");
    const downColor = resolveToken("--danger");

    const markLineData = buildMarkLineData(dayGroups);
    const markLine = { symbol: "none" as const, silent: false, data: markLineData };

    const barSeries = bars.map((bar, i) => ({
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
      ...(i === 0 ? { markLine } : {}),
    }));

    // No bars → a hidden anchor series carries the markers so they still render
    // against the grid (parity with the line chart's D-08 empty state).
    const anchorSeries = {
      name: "__growth_anchor__",
      type: "bar" as const,
      data: [] as [string, number][],
      markLine,
    };

    return {
      ...baseChartOptions({ reducedMotion }),
      // No ECharts native legend — the custom <ChartLegend> at the page drives
      // per-listing visibility via the shared `visible` map (04-09).
      grid: { left: 8, right: 8, top: 16, bottom: 36, containLabel: true },
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
  {#if typeof window !== "undefined"}
    <div class="chart-canvas">
      <Chart {init} {options} onclick={onChartClick} />
    </div>
  {/if}

  {#if !hasData}
    <!-- Low/empty (D-07/D-08 parity): a caption, not an empty bar grid. The
         markers still render above when there are events in range. -->
    <p class="growth-low-data">{m.viz_growth_low_data()}</p>
  {/if}
</div>

{#if selectedGroup}
  <EventMarkerPanel
    dayEvents={selectedGroup.events}
    delta={null}
    {sources}
    {games}
    onClose={closePanel}
  />
{/if}

<style>
  .wishlist-growth-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    width: 100%;
  }
  .chart-canvas {
    width: 100%;
    height: 240px;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .growth-low-data {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
  }
</style>

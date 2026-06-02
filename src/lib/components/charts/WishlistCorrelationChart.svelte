<script lang="ts">
  // WishlistCorrelationChart — VIZ-02 == VIZ-03, the product's headline
  // "did this post move the needle?" chart (D-12). ONE component on
  // /games/[gameId]: ONE WISH-04 daily wishlist line PER active Steam listing
  // + vertical event markers colored by kind, same-day events collapsed to one
  // marker + count badge.
  //
  // Multi-listing (04-07): the decision (user) is a separate line per store —
  // NOT a summed line (Steam + itch are different units). Each listing gets a
  // distinct color from a per-line palette (NOT the --k-* kind colors, which
  // belong to the event markers). The custom <ChartLegend> at the page toggles
  // each line on/off via the shared `visible` map.
  //
  // ECharts (RESEARCH Pattern 4):
  //   - one wishlist daily-balance LineChart series per listing (yAxis =
  //     abbreviate, D-11), named with the listing label for the legend.
  //   - markLine.data = one vertical line per DISTINCT event-DAY, colored by
  //     resolveKindColor(kind) (D-01); a mixed-kind day → neutral --k-post
  //     (D-04). >1 event that day → a count badge "N" at the top (D-04). The
  //     markLine attaches to the FIRST visible listing series (or, when no
  //     listing has points, a hidden anchor series) so it renders against the
  //     chart grid and stays visible regardless of which lines are toggled.
  //   - markArea.data = the highlighted post-event window (windowFrom..windowTo)
  //     set on marker click — the D-03 "event → effect" segment.
  //   - click a marker → resolve the day → open <EventMarkerPanel> with the
  //     day's events + that day's delta (D-05 day-level).
  //
  // Date-range + legend (04-08 / 04-09): the date-range picker and the
  // per-listing legend selection are OWNED BY THE PAGE so a sibling
  // WishlistGrowthChart shares the same window + the same visible listings. This
  // component is CONTROLLED: it receives `range` + `visible` as props. The
  // already-loaded daily series is clipped to [from, to] inclusive; markers
  // outside the window are hidden; a toggled-off listing's line is hidden by
  // FILTERING the series array on `visible[id]` (04-09) — there is NO ECharts
  // native legend anymore. The custom on-brand <ChartLegend> at the page flips
  // entries in `visible`; driving visibility purely from that map is what fixes
  // the legend re-enable bug (no ECharts select-changed event round-trip).
  //
  // SSR (RESEARCH Pitfall 1): the option object resolves --k-* tokens via
  // getComputedStyle (canvas can't read CSS vars), so it's built client-only
  // and the <Chart> is gated on `typeof window !== "undefined"`.
  //
  // D-08: no CSV imported (no listing has points) → the empty-state CTA to
  // wishlist import renders, but the event markers/timeline STILL render.
  //
  // D-13: the honest "обновлено Xч назад" caption is computed from the
  // most-recent series.lastImportedAt across the VISIBLE listings, against the
  // SERVER `today` instant (a prop), never the client clock.
  //
  // VIZ-04 (D-10/D-11): svelte-echarts' ResizeObserver drives chart.resize();
  // adaptive thinning (fewer xAxis ticks, larger markers) keeps it legible at
  // narrow widths — NOT horizontal scroll. Labels abbreviate via `abbreviate`.

  import { Chart } from "svelte-echarts";
  import { init, use } from "echarts/core";
  import { LineChart } from "echarts/charts";
  import {
    GridComponent,
    TooltipComponent,
    MarkLineComponent,
    MarkAreaComponent,
  } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import type { EChartsType } from "echarts/core";
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
  import type { EventDto, GameDto, DataSourceDto, WishlistSeries, WishlistDelta } from "$lib/server/dto.js";

  use([
    LineChart,
    GridComponent,
    TooltipComponent,
    MarkLineComponent,
    MarkAreaComponent,
    CanvasRenderer,
  ]);

  let {
    seriesByListing,
    events,
    deltaByDate,
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
    /** Per-listing, per-day wishlist deltas: deltaByDate[listingId][YYYY-MM-DD]. */
    deltaByDate: Record<string, Record<string, WishlistDelta>>;
    /** Active listings (id + display name / appId) — drives line labels + order. */
    listings: ListingLite[];
    sources: DataSourceDto[];
    games: GameDto[];
    /** Server-chosen "now" ISO instant for the honest D-13 caption + range guard. */
    today: string;
    /** Shared date-range (owned by the page) — null = all time. CONTROLLED. */
    range: { from: Date; to: Date } | null;
    /** Shared legend selection (owned by the page): listingId → shown. CONTROLLED.
     *  Visibility is driven PURELY from this map — the series array is filtered
     *  by it (no ECharts legend round-trip), which is what fixes the re-enable
     *  bug. The custom <ChartLegend> at the page flips entries in this map. */
    visible: Record<string, boolean>;
  } = $props();

  function listingLabel(l: ListingLite): string {
    return buildListingLabel(
      l,
      (appId) => m.viz_legend_listing_fallback({ appId }),
      () => m.viz_wishlist_line_label(),
    );
  }

  // A listing is visible unless the shared legend map explicitly turned it off.
  function isVisible(listingId: string): boolean {
    return visible[listingId] !== false;
  }

  // ── Per-listing lines (filtered by range + the shared `visible` map) ──
  // Series visibility is driven PURELY by `visible[id] !== false` (the custom
  // legend at the page flips it). Filtering the series array here — instead of
  // an ECharts legend toggle — is the load-bearing fix for the re-enable bug:
  // turning a listing back ON re-adds its line on the next render.
  type Line = { id: string; label: string; color: string; points: { date: string; balance: number }[]; lastImportedAt: string | null };

  const lines = $derived.by((): Line[] => {
    return listings
      .filter((l) => isVisible(l.id))
      .map((l): Line => {
        const s = seriesByListing[l.id] ?? { points: [], lastImportedAt: null };
        return {
          id: l.id,
          label: listingLabel(l),
          color: listingColor(listings, l.id),
          points: s.points.filter((p) => inRange(p.date, range)),
          lastImportedAt: s.lastImportedAt,
        };
      })
      .filter((line) => line.points.length > 0);
  });

  const hasSeries = $derived(lines.length > 0);

  // ── Event-day markers (shared with the growth chart) ─────────────────
  const dayGroups = $derived(buildDayGroups(events, range));

  // X-axis domain = union of ALL listings' wishlist-point dates (NOT the
  // visibility-filtered `lines` — toggling a listing off must never collapse
  // the axis) ∪ event days, clamped to the range. This is what keeps the event
  // markers on-canvas when the wishlist span is shorter than the event span.
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

  // Marker count for the test hook (number of DISTINCT event-days rendered).
  const markerCount = $derived(dayGroups.length);

  // Honest D-13 caption hours: most-recent lastImportedAt across the VISIBLE
  // listings vs the SERVER `today`. null when no visible listing has an import
  // time (the empty-state CTA covers the no-CSV case).
  const updatedHoursAgo = $derived.by((): number | null => {
    const stamps = lines
      .map((l) => l.lastImportedAt)
      .filter((s): s is string => s !== null)
      .map((s) => new Date(s).getTime());
    if (stamps.length === 0) return null;
    const last = Math.max(...stamps);
    const now = new Date(today).getTime();
    return Math.max(0, Math.floor((now - last) / 3_600_000));
  });

  // ── Selected day → panel + markArea (D-02/D-03) ──────────────────────
  let selectedDay = $state<string | null>(null);
  const selectedGroup = $derived(
    selectedDay ? (dayGroups.find((g) => g.date === selectedDay) ?? null) : null,
  );
  // The delta is a DAY attribute (D-05). With multiple listings it is per
  // listing; surface the first VISIBLE listing's delta for that day (the panel
  // shows one day-level delta). Falls back across visible listings.
  const selectedDelta = $derived.by((): WishlistDelta | null => {
    if (!selectedDay) return null;
    for (const line of lines) {
      const d = deltaByDate[line.id]?.[selectedDay];
      if (d) return d;
    }
    return null;
  });

  // Bindable chart instance — set the D-03 markArea on it directly when a
  // marker is selected (the highlighted post-event window).
  let chart = $state<EChartsType | undefined>();

  function closePanel(): void {
    selectedDay = null;
  }

  // markLine click → resolve the clicked day → open the panel. ECharts fires
  // the chart-level 'click' with componentType 'markLine'; the marker carries
  // its day in `value`/`name` (we set name = date on each markLine datum).
  function onChartClick(e: ECMouseEvent): void {
    if (e.componentType !== "markLine") return;
    const day = (e.data as { name?: string } | undefined)?.name;
    if (typeof day === "string") selectedDay = day;
  }

  // markLine attaches to the FIRST visible line (or the hidden anchor series
  // when no listing has points). Its series name drives the markArea patch.
  const markLineSeriesName = $derived(lines[0]?.label ?? "__wishlist_anchor__");

  // D-03 markArea: highlight the post-event window for the selected day.
  // Driven by an $effect on the bindable chart instance so it patches markArea
  // without a full option rebuild (markArea is transient selection state).
  //
  // The effect is INERT until the first marker click: svelte-echarts applies
  // the base `options` (incl. xAxis) in its own $effect, which can run AFTER
  // this one at mount — patching markArea before xAxis exists throws
  // `xAxis "0" not found`. `hasPatchedMarkArea` gates the no-op clear so we
  // only call setOption once there's a real selection.
  let hasPatchedMarkArea = $state(false);
  $effect(() => {
    if (!chart) return;
    const day = selectedDay; // reactive trigger
    if (!day && !hasPatchedMarkArea) return; // inert until first selection
    hasPatchedMarkArea = true;
    const delta = day ? selectedDelta : null;
    chart.setOption({
      series: [
        {
          name: markLineSeriesName,
          type: "line" as const,
          markArea: delta
            ? {
                silent: true,
                itemStyle: { color: "color-mix(in oklab, var(--accent) 14%, transparent)" },
                data: [[{ xAxis: delta.windowFrom }, { xAxis: delta.windowTo }]],
              }
            : { data: [] },
        },
      ],
    });
  });

  // ── ECharts option (client-only — resolves --k-* tokens) ─────────────
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();

    // One vertical markLine per distinct event-DAY (D-01), shared verbatim with
    // the growth chart so markers are pixel-identical across both.
    const markLineData = buildMarkLineData(dayGroups);

    const markLine = {
      symbol: "none" as const,
      silent: false,
      // Markers render even with an empty wishlist series (D-08).
      data: markLineData,
    };

    // One LineChart series per visible listing. The FIRST series carries the
    // shared markLine markers so they read against the grid regardless of which
    // lines the legend toggles off (markers are date-keyed + shared).
    const lineSeries = lines.map((line, i) => ({
      name: line.label,
      type: "line" as const,
      showSymbol: false,
      symbolSize: 14, // D-10 tap-friendly hit target at narrow widths.
      lineStyle: { width: 2, color: line.color },
      itemStyle: { color: line.color },
      data: line.points.map((p) => [p.date, p.balance]),
      ...(i === 0 ? { markLine, markArea: { data: [] } } : {}),
    }));

    // D-08: no listing has points → a hidden anchor series carries the markLine
    // so the event markers still render against the grid.
    const anchorSeries = {
      name: markLineSeriesName,
      type: "line" as const,
      showSymbol: false,
      data: [] as [string, number][],
      markLine,
      markArea: { data: [] },
    };

    return {
      ...baseChartOptions({ reducedMotion }),
      // No ECharts native legend — the custom on-brand <ChartLegend> at the page
      // drives per-listing visibility via the shared `visible` map (04-09).
      grid: { left: 8, right: 8, top: 16, bottom: 36, containLabel: true },
      xAxis: {
        type: "time" as const,
        // D-10 adaptive thinning: cap the tick count so narrow widths thin
        // out instead of overcrowding; ECharts spaces the rest.
        splitNumber: 4,
        axisLabel: { hideOverlap: true },
        // Force the domain to span points ∪ events so off-window event markers
        // render (the regression: ECharts auto-fits the axis to the series).
        ...(domain ? { min: domain.min, max: domain.max } : {}),
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { formatter: (v: number): string => abbreviate(v) },
      },
      series: lineSeries.length > 0 ? lineSeries : [anchorSeries],
    };
  });
</script>

<div
  class="wishlist-correlation-chart"
  data-testid="wishlist-correlation-chart"
  data-marker-count={markerCount}
  data-low-data={hasSeries ? "false" : "true"}
  data-line-count={lines.length}
>
  <!-- Date-range control + legend now live at the PAGE (04-08) so the sibling
       growth chart shares the same window + visible listings. This component is
       controlled via the `range` + `visible` props. -->

  {#if typeof window !== "undefined"}
    <div class="chart-canvas">
      <Chart {init} {options} bind:chart onclick={onChartClick} />
    </div>
  {/if}

  {#if !hasSeries}
    <!-- D-08: no CSV imported → empty-state CTA; markers still render above. -->
    <p class="no-wishlist-cta">
      {m.chart_no_wishlist_cta()}
      <a class="no-wishlist-cta-link" href="/keys/steam">{m.chart_no_wishlist_cta_link()}</a>
    </p>
  {:else if updatedHoursAgo !== null}
    <!-- D-13: honest caption from the real import time vs the server clock. -->
    <p class="updated-caption">{m.viz_wishlist_updated_ago({ hours: updatedHoursAgo })}</p>
  {/if}
</div>

{#if selectedGroup}
  <EventMarkerPanel
    dayEvents={selectedGroup.events}
    delta={selectedDelta}
    {sources}
    {games}
    onClose={closePanel}
  />
{/if}

<style>
  .wishlist-correlation-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    /* VIZ-04: the chart reflows within its column — never adds page-level
     * horizontal scroll. */
    width: 100%;
  }
  .chart-canvas {
    width: 100%;
    height: 300px;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .no-wishlist-cta {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .no-wishlist-cta-link {
    color: var(--accent);
    text-decoration: underline;
    margin-left: 4px;
  }
  .updated-caption {
    margin: 0;
    font-size: var(--t-12, 12px);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
</style>

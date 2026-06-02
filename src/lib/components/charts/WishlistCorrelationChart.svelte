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
  // belong to the event markers). An ECharts legend toggles each line on/off.
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
  // Date-range (04-07): a date-chip + DateRangePicker + an "All time" reset
  // above the chart filters the visible window CLIENT-SIDE against the server
  // `today` instant (never `new Date()`). The already-loaded daily series is
  // clipped to [from, to] inclusive; markers outside the window are hidden.
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
    LegendComponent,
    MarkLineComponent,
    MarkAreaComponent,
  } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import type { EChartsType } from "echarts/core";
  import type { ECMouseEvent } from "svelte-echarts";
  import EventMarkerPanel from "./EventMarkerPanel.svelte";
  import DateRangePicker from "$lib/components/feed/DateRangePicker.svelte";
  import { startOfDay, fmtMonthDay } from "$lib/feed/date-range.js";
  import { m } from "$lib/paraglide/messages.js";
  import { abbreviate } from "./abbreviate.js";
  import { baseChartOptions, prefersReducedMotion, resolveKindColor } from "./chart-theme.js";
  import type { EventDto, GameDto, DataSourceDto, WishlistSeries, WishlistDelta } from "$lib/server/dto.js";

  use([
    LineChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    MarkLineComponent,
    MarkAreaComponent,
    CanvasRenderer,
  ]);

  type ListingLite = { id: string; name?: string | null; appId?: number };

  let {
    seriesByListing,
    events,
    deltaByDate,
    listings,
    sources,
    games,
    today,
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
  } = $props();

  // Per-line palette — distinct from the --k-* kind colors (those belong to the
  // event markers). Cycles when there are more listings than entries.
  const LINE_PALETTE = ["#5b8def", "#e0a458", "#5fb98e", "#c25b9e", "#7d6ad6", "#d2705a"];

  function listingLabel(l: ListingLite): string {
    if (l.name && l.name.trim()) return l.name;
    if (typeof l.appId === "number") return m.viz_legend_listing_fallback({ appId: l.appId });
    return m.viz_wishlist_line_label();
  }

  // ── Date range (04-07) ───────────────────────────────────────────────
  // null = all time. Applied against the SERVER `today` instant, never the
  // client clock. The picker is an anchored popover (DateRangePicker) opened
  // from the date-chip; an "All time" chip resets the range to null.
  const todayDate = $derived(startOfDay(new Date(today)));
  let range = $state<{ from: Date; to: Date } | null>(null);
  let pickerOpen = $state(false);
  let chipEl = $state<HTMLButtonElement | undefined>();
  let anchorTop = $state(0);
  let anchorLeft = $state(0);

  function openPicker(): void {
    if (chipEl) {
      const rect = chipEl.getBoundingClientRect();
      anchorTop = rect.bottom + 4;
      anchorLeft = rect.left;
    }
    pickerOpen = true;
  }

  const rangeChipLabel = $derived(
    range ? `${fmtMonthDay(range.from)} – ${fmtMonthDay(range.to)}` : m.viz_range_all_time(),
  );

  // A daily YYYY-MM-DD point is in-window when it falls within [from, to]
  // inclusive. range === null ⇒ everything passes.
  function inRange(dateStr: string): boolean {
    if (!range) return true;
    return dateStr >= isoDay(range.from) && dateStr <= isoDay(range.to);
  }

  function isoDay(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  // ── Per-listing lines (filtered by range) ────────────────────────────
  type Line = { id: string; label: string; color: string; points: { date: string; balance: number }[]; lastImportedAt: string | null };

  const lines = $derived.by((): Line[] => {
    return listings
      .map((l, i): Line => {
        const s = seriesByListing[l.id] ?? { points: [], lastImportedAt: null };
        return {
          id: l.id,
          label: listingLabel(l),
          color: LINE_PALETTE[i % LINE_PALETTE.length]!,
          points: s.points.filter((p) => inRange(p.date)),
          lastImportedAt: s.lastImportedAt,
        };
      })
      .filter((line) => line.points.length > 0);
  });

  const hasSeries = $derived(lines.length > 0);

  // ── Group events by DAY (D-04/D-05), filtered by range ───────────────
  // The marker + the delta are DAY attributes: truncate occurredAt to
  // YYYY-MM-DD and collapse all events that day to one entry. Markers outside
  // the selected range are hidden (04-07).
  type DayGroup = { date: string; events: EventDto[]; mixedKind: boolean; kind: string };

  function dayOf(e: EventDto): string {
    const d = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : e.occurredAt;
    return d.toISOString().slice(0, 10);
  }

  const dayGroups = $derived.by((): DayGroup[] => {
    const byDay = new Map<string, EventDto[]>();
    for (const e of events) {
      const day = dayOf(e);
      if (!inRange(day)) continue;
      const arr = byDay.get(day);
      if (arr) arr.push(e);
      else byDay.set(day, [e]);
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, evs]) => {
        const kinds = new Set(evs.map((e) => e.kind));
        const mixedKind = kinds.size > 1;
        return { date, events: evs, mixedKind, kind: evs[0]!.kind };
      });
  });

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

    // One vertical markLine per distinct event-DAY (D-01). Mixed-kind day →
    // neutral --k-post (D-04). >1 event → count badge "N" at the top.
    const markLineData = dayGroups.map((g) => {
      const color = g.mixedKind ? resolveKindColor("post") : resolveKindColor(g.kind);
      const count = g.events.length;
      return {
        name: g.date,
        xAxis: g.date,
        lineStyle: { color, width: 2 },
        label:
          count > 1
            ? {
                show: true,
                position: "start" as const,
                distance: 4,
                formatter: String(count),
                color: "#fff",
                backgroundColor: color,
                padding: [2, 5],
                borderRadius: 8,
                fontSize: 10,
                fontWeight: "bold" as const,
              }
            : { show: false },
      };
    });

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
      legend: {
        show: lines.length > 0,
        type: "scroll" as const,
        bottom: 0,
        textStyle: { color: resolveTextColor() },
      },
      grid: { left: 8, right: 8, top: 16, bottom: 36, containLabel: true },
      xAxis: {
        type: "time" as const,
        // D-10 adaptive thinning: cap the tick count so narrow widths thin
        // out instead of overcrowding; ECharts spaces the rest.
        splitNumber: 4,
        axisLabel: { hideOverlap: true },
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { formatter: (v: number): string => abbreviate(v) },
      },
      series: lineSeries.length > 0 ? lineSeries : [anchorSeries],
    };
  });

  function resolveTextColor(): string {
    if (typeof window === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue("--text-2").trim();
  }
</script>

<div
  class="wishlist-correlation-chart"
  data-testid="wishlist-correlation-chart"
  data-marker-count={markerCount}
  data-low-data={hasSeries ? "false" : "true"}
  data-line-count={lines.length}
>
  <!-- Date-range control (04-07): a date-chip opens the DateRangePicker; the
       "All time" chip resets the visible window. Filters client-side against
       the server `today` instant. -->
  <div class="range-row">
    <button
      bind:this={chipEl}
      type="button"
      class="range-chip"
      data-custom={range ? "1" : "0"}
      onclick={openPicker}
      title={m.viz_range_label()}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 11h18" />
      </svg>
      <span>{rangeChipLabel}</span>
    </button>
    <button
      type="button"
      class="range-reset"
      data-active={range ? "0" : "1"}
      onclick={() => (range = null)}
    >
      {m.viz_range_all_time()}
    </button>
  </div>

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

<DateRangePicker
  value={range}
  open={pickerOpen}
  {anchorTop}
  {anchorLeft}
  today={todayDate}
  onApply={(r) => (range = { from: r.from, to: r.to })}
  onClose={() => (pickerOpen = false)}
/>

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
  .range-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  .range-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    height: 32px;
    padding: 0 var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .range-chip:hover {
    border-color: var(--accent);
  }
  .range-chip[data-custom="1"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 45%, var(--border));
    color: var(--accent-strong);
    font-weight: var(--w-sb);
  }
  .range-reset {
    height: 28px;
    padding: 0 var(--s-3);
    background: var(--surface);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .range-reset:hover {
    color: var(--text);
    border-color: var(--border-2);
  }
  .range-reset[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent-strong);
    border-color: color-mix(in oklab, var(--accent) 50%, transparent);
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
  @media (prefers-reduced-motion: reduce) {
    .range-chip,
    .range-reset {
      transition: none;
    }
  }
</style>

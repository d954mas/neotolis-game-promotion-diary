<script lang="ts">
  // WishlistCorrelationChart — VIZ-02 == VIZ-03, the product's headline
  // "did this post move the needle?" chart (D-12). ONE component on
  // /games/[gameId]: the WISH-04 daily wishlist line + vertical event markers
  // colored by kind, same-day events collapsed to one marker + count badge.
  //
  // ECharts (RESEARCH Pattern 4):
  //   - the wishlist daily balance LineChart series (yAxis = abbreviate, D-11)
  //   - markLine.data = one vertical line per DISTINCT event-DAY, colored by
  //     resolveKindColor(kind) (D-01); a mixed-kind day → neutral --k-post
  //     (D-04). >1 event that day → a count badge "N" at the top (D-04).
  //   - markArea.data = the highlighted post-event window (windowFrom..windowTo)
  //     set on marker click — the D-03 "event → effect" segment.
  //   - click a marker → resolve the day → open <EventMarkerPanel> with the
  //     day's events + that day's delta (D-05 day-level).
  //
  // SSR (RESEARCH Pitfall 1): the option object resolves --k-* tokens via
  // getComputedStyle (canvas can't read CSS vars), so it's built client-only
  // and the <Chart> is gated on `typeof window !== "undefined"`.
  //
  // D-08: no CSV imported (empty series) → the empty-state CTA to wishlist
  // import renders, but the event markers/timeline STILL render.
  //
  // D-13: the honest "обновлено Xч назад" caption is computed from the real
  // series.lastImportedAt against the SERVER `today` instant (a prop), never
  // the client clock.
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
  import { baseChartOptions, prefersReducedMotion, resolveKindColor } from "./chart-theme.js";
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
    series,
    events,
    deltaByDate,
    sources,
    games,
    today,
  }: {
    series: WishlistSeries;
    events: EventDto[];
    deltaByDate: Record<string, WishlistDelta>;
    sources: DataSourceDto[];
    games: GameDto[];
    /** Server-chosen "now" ISO instant for the honest D-13 caption. */
    today: string;
  } = $props();

  // ── Group events by DAY (D-04/D-05) ──────────────────────────────────
  // The marker + the delta are DAY attributes: truncate occurredAt to
  // YYYY-MM-DD and collapse all events that day to one entry.
  type DayGroup = { date: string; events: EventDto[]; mixedKind: boolean; kind: string };

  function dayOf(e: EventDto): string {
    const d = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : e.occurredAt;
    return d.toISOString().slice(0, 10);
  }

  const dayGroups = $derived.by((): DayGroup[] => {
    const byDay = new Map<string, EventDto[]>();
    for (const e of events) {
      const day = dayOf(e);
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

  const hasSeries = $derived(series.points.length > 0);

  // Honest D-13 caption hours: real lastImportedAt vs the SERVER `today`.
  // null lastImportedAt (no CSV) → no caption (the empty-state CTA covers it).
  const updatedHoursAgo = $derived.by((): number | null => {
    if (!series.lastImportedAt) return null;
    const last = new Date(series.lastImportedAt).getTime();
    const now = new Date(today).getTime();
    return Math.max(0, Math.floor((now - last) / 3_600_000));
  });

  // ── Selected day → panel + markArea (D-02/D-03) ──────────────────────
  let selectedDay = $state<string | null>(null);
  const selectedGroup = $derived(
    selectedDay ? (dayGroups.find((g) => g.date === selectedDay) ?? null) : null,
  );
  const selectedDelta = $derived(selectedDay ? (deltaByDate[selectedDay] ?? null) : null);

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
          name: m.viz_wishlist_line_label(),
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
        // D-04 count badge near the TOP edge (position 'start' = top of the
        // line), only when the day collapses >1 event. distance clears the
        // wishlist line.
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

    return {
      ...baseChartOptions({ reducedMotion }),
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
      series: [
        {
          name: m.viz_wishlist_line_label(),
          type: "line" as const,
          showSymbol: false,
          // D-10 tap-friendly hit target at narrow widths.
          symbolSize: 14,
          lineStyle: { width: 2 },
          data: series.points.map((p) => [p.date, p.balance]),
          markLine: {
            symbol: "none" as const,
            silent: false,
            // Markers render even with an empty wishlist series (D-08).
            data: markLineData,
          },
          // markArea is set transiently on selection via the $effect above.
          markArea: { data: [] },
        },
      ],
    };
  });
</script>

<div
  class="wishlist-correlation-chart"
  data-testid="wishlist-correlation-chart"
  data-marker-count={markerCount}
  data-low-data={hasSeries ? "false" : "true"}
>
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
    height: 280px;
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

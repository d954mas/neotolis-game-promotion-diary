<script lang="ts">
  // EventHistoryChart — VIZ-01 per-event snapshot-history chart (D-14).
  //
  // The ONLY leaf in the app that touches ECharts. Consumes the
  // library-agnostic EventMetricSeries[] the adapter's fetchEventMetricSeries
  // contributes (Plan 04-02) — never a mutable current-value column (POLL-04).
  //
  // All metrics on ONE line chart, each a distinct color, with a CUSTOM on-brand
  // legend below (a metric icon + color swatch + text per series) that toggles
  // any series on/off — so the small-magnitude metrics (likes/comments) that a
  // shared linear axis flattens next to views can be isolated. Visibility is
  // driven by filtering the series array; the swatch/line colour comes from the
  // shared semantic metric-color map ($lib/util/metric-colors), keyed by the
  // metric (not the series index), so toggling/ordering never reshuffles colours
  // and a metric reads the same colour here as on the cards + detail stats.
  //
  // SSR (RESEARCH Pitfall 1): the <Chart> inits the canvas in onMount and the
  // option is built only under `typeof window`.
  //
  // D-07 low-data branch: <3 points on every series → dots + caption, never a
  // 2-point trend line.

  import { Chart } from "svelte-echarts";
  import { init, use } from "echarts/core";
  import { LineChart } from "echarts/charts";
  import { GridComponent, TooltipComponent } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import { m } from "$lib/paraglide/messages.js";
  import { baseChartOptions, prefersReducedMotion } from "./chart-theme.js";
  import { abbreviate } from "./abbreviate.js";
  import { metricColorForLabelKey } from "$lib/util/metric-colors.js";
  import type { EventMetricSeries } from "$lib/sources/adapter.js";

  use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

  let { series, kind: _kind }: { series: EventMetricSeries[]; kind: string } = $props();

  // Per-metric inline icon (geometric, stroke=currentColor so it takes the chip
  // colour). Keyed by the adapter's labelKey; fallback = a dot.
  const METRIC_ICON: Record<string, string> = {
    chart_metric_views:
      '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
    chart_metric_likes:
      '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/>',
    chart_metric_comments:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chart_metric_num_comments:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chart_metric_score: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  };
  function metricIcon(labelKey: string): string {
    return METRIC_ICON[labelKey] ?? '<circle cx="12" cy="12" r="8"/>';
  }

  const messages = m as unknown as Record<string, () => string>;
  function label(labelKey: string): string {
    const fn = messages[labelKey];
    return fn ? fn() : labelKey;
  }

  // labelKey → hidden (toggled off in the custom legend). Absent = shown.
  let hidden = $state<Record<string, boolean>>({});
  function toggle(labelKey: string): void {
    hidden = { ...hidden, [labelKey]: !hidden[labelKey] };
  }
  function shown(labelKey: string): boolean {
    return hidden[labelKey] !== true;
  }

  const maxPoints = $derived(Math.max(0, ...series.map((s) => s.points.length)));
  // D-07: <3 snapshots on every series → dots + caption, never a 2-point line.
  const lowData = $derived(maxPoints < 3);

  function dateLabel(value: unknown): string {
    const d = new Date(value as string | number);
    return Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleDateString("en", { month: "short", day: "numeric" });
  }

  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();
    const base = baseChartOptions({ reducedMotion });
    return {
      ...base,
      grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis" as const,
        formatter: (raw: unknown): string => {
          const params = (Array.isArray(raw) ? raw : [raw]) as Array<{
            marker?: string;
            seriesName?: string;
            value?: unknown;
            axisValue?: unknown;
          }>;
          if (params.length === 0) return "";
          const head = `<div style="font-weight:600;margin-bottom:4px;">${dateLabel(params[0]?.axisValue)}</div>`;
          const rows = params
            .map((p) => {
              const v = Array.isArray(p.value) ? p.value[1] : p.value;
              const num = typeof v === "number" ? abbreviate(v) : "—";
              return `<div style="display:flex;align-items:center;gap:8px;"><span>${p.marker ?? ""}${p.seriesName ?? ""}</span><span style="margin-left:auto;font-variant-numeric:tabular-nums;">${num}</span></div>`;
            })
            .join("");
          return `<div style="min-width:120px;">${head}${rows}</div>`;
        },
      },
      xAxis: {
        type: "time" as const,
        axisLabel: { formatter: (v: number): string => dateLabel(v), hideOverlap: true },
      },
      series: series
        .map((s) => ({ s, color: metricColorForLabelKey(s.labelKey) }))
        .filter(({ s }) => shown(s.labelKey))
        .map(({ s, color }) => ({
          name: label(s.labelKey),
          type: "line" as const,
          smooth: true,
          showSymbol: true,
          symbol: "circle" as const,
          symbolSize: lowData ? 8 : 4,
          lineStyle: lowData ? { opacity: 0 } : { color, width: 2 },
          itemStyle: { color },
          data: s.points.map((p) => [p.polledAt, p.value]),
        })),
    };
  });
</script>

<div class="event-history-chart" data-testid="event-history-chart" data-low-data={lowData}>
  <h3 class="chart-title">{m.chart_history_title()}</h3>

  {#if maxPoints > 0 && typeof window !== "undefined"}
    <div class="chart-canvas" class:low-data={lowData}>
      <Chart {init} {options} />
    </div>
  {/if}

  {#if series.length > 0}
    <!-- Custom on-brand legend: metric icon + colour + text, click to toggle. -->
    <div class="metric-legend" role="group" aria-label={m.chart_history_title()}>
      {#each series as s (s.labelKey)}
        {@const c = metricColorForLabelKey(s.labelKey)}
        <button
          type="button"
          class="metric-chip"
          class:off={!shown(s.labelKey)}
          aria-pressed={shown(s.labelKey)}
          style={`--mc:${c};`}
          onclick={() => toggle(s.labelKey)}
        >
          <svg
            class="metric-ico"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true">{@html metricIcon(s.labelKey)}</svg
          >
          <span class="metric-text">{label(s.labelKey)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if lowData}
    <p class="chart-low-data-caption">{m.chart_low_data_caption()}</p>
  {/if}
</div>

<style>
  .event-history-chart {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .chart-title {
    margin: 0;
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    color: var(--text-2);
    letter-spacing: -0.006em;
  }
  .chart-canvas {
    width: 100%;
    height: 220px;
    font-variant-numeric: tabular-nums;
  }
  /* Custom legend — one toggle chip per metric: icon (in the metric colour) +
   * text. Off state dims + strikes the chip so it reads as "hidden, click to
   * bring back". Centered under the chart (Millo-style). */
  .metric-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-2);
  }
  .metric-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 var(--s-3);
    background: var(--surface-2);
    /* Active (shown) state reads as a PRESSED toggle (#8): the metric color
     * tints the border + a soft shadow lifts it off the surface, so even with
     * every metric on the chips clearly look pressable — not flat labels. */
    border: 1px solid var(--mc);
    border-radius: var(--r-pill);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease),
      background var(--m-fast) var(--m-ease);
  }
  .metric-ico {
    width: 15px;
    height: 15px;
    color: var(--mc);
    flex-shrink: 0;
  }
  .metric-chip:hover {
    border-color: var(--mc);
    background: var(--surface-3, var(--surface));
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.24);
  }
  .metric-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (prefers-reduced-motion: reduce) {
    .metric-chip {
      transition: none;
    }
  }
  /* Off (hidden) state: flat, dim + strikethrough — clearly "click to bring
   * back", visually opposite the elevated active chip. */
  .metric-chip.off {
    opacity: 0.5;
    color: var(--text-3);
    border-color: var(--border);
    box-shadow: none;
  }
  .metric-chip.off .metric-ico {
    color: var(--text-3);
  }
  .metric-chip.off .metric-text {
    text-decoration: line-through;
  }
  .chart-low-data-caption {
    margin: 0;
    font-size: var(--t-12, 12px);
    font-style: italic;
    color: var(--text-3);
  }
</style>

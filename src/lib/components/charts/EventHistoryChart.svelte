<script lang="ts">
  // EventHistoryChart — VIZ-01 per-event snapshot-history chart (D-14).
  //
  // The ONLY leaf in the app that touches ECharts. Consumes the
  // library-agnostic EventMetricSeries[] the loader collects from the
  // adapter's fetchEventMetricSeries (Plan 04-02) — never a mutable
  // current-value column (POLL-04). Renders identically in the
  // EventDetailModal and the /events/[id] SSR fallback because it mounts
  // inside the shared <EventDetailContent> (dual-render).
  //
  // SSR (RESEARCH Pitfall 1): the svelte-echarts <Chart> wrapper inits the
  // canvas inside onMount, so the server render never touches `document`.
  // The series DATA is computed server-side in the loader (SSR-safe); only
  // the canvas mounts client-side. We additionally gate the <Chart> render
  // on `typeof window !== "undefined"` so the option object (which resolves
  // `--k-*` tokens via getComputedStyle) is only built in the browser.
  //
  // D-07 low-data branch: when EVERY series has <3 points a 2-point trend
  // line would mislead, so we render the available points as DOTS
  // (showSymbol, lineStyle.opacity 0) PLUS the m.chart_low_data_caption.
  // With zero points we render only the caption. data-low-data exposes the
  // branch to the browser test without introspecting canvas pixels.

  import { Chart } from "svelte-echarts";
  import { init, use } from "echarts/core";
  import { LineChart } from "echarts/charts";
  import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import { m } from "$lib/paraglide/messages.js";
  import { baseChartOptions, prefersReducedMotion } from "./chart-theme.js";
  import { abbreviate } from "./abbreviate.js";
  import type { EventMetricSeries } from "$lib/sources/adapter.js";

  use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

  let { series, kind: _kind }: { series: EventMetricSeries[]; kind: string } = $props();

  // Each metric (views / likes / comments …) gets a DISTINCT color so the lines
  // and the (toggleable) legend swatches are tellable apart — they used to all
  // share the single kind color, which made the chart + legend unreadable.
  const METRIC_COLORS = ["#5b8def", "#e0a458", "#5fb98e", "#c25b9e", "#7d6ad6"];

  // A polled-at timestamp → a compact "May 12" axis/tooltip label.
  function dateLabel(value: unknown): string {
    const d = new Date(value as string | number);
    return Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleDateString("en", { month: "short", day: "numeric" });
  }

  // Paraglide exposes each key as a zero-arg message fn. labelKey is a
  // runtime string handle (e.g. "chart_metric_views"); index into the m
  // namespace to resolve the legend label. Cast keeps TS honest without a
  // per-key switch.
  const messages = m as unknown as Record<string, () => string>;
  function label(labelKey: string): string {
    const fn = messages[labelKey];
    return fn ? fn() : labelKey;
  }

  const maxPoints = $derived(Math.max(0, ...series.map((s) => s.points.length)));
  // D-07: <3 snapshots on every series → dots + caption, never a 2-point line.
  const lowData = $derived(maxPoints < 3);

  // Build the ECharts option client-only — resolveKindColor reads CSS vars
  // via getComputedStyle (canvas can't see --k-* tokens), unavailable under
  // SSR. The {#if typeof window} guard ensures this never runs server-side.
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();
    const base = baseChartOptions({ reducedMotion });
    return {
      ...base,
      // Room at the top for the legend + at the bottom for the date labels.
      grid: { left: 8, right: 12, top: 34, bottom: 8, containLabel: true },
      legend: { type: "scroll" as const, top: 0, icon: "roundRect" as const },
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
      series: series.map((s, i) => {
        const color = METRIC_COLORS[i % METRIC_COLORS.length]!;
        return {
          name: label(s.labelKey),
          type: "line" as const,
          smooth: true,
          showSymbol: true,
          symbol: "circle" as const,
          symbolSize: lowData ? 8 : 4,
          // D-07: hide the connecting line in the low-data branch so two points
          // never read as a trend; only the dots remain.
          lineStyle: lowData ? { opacity: 0 } : { color, width: 2 },
          itemStyle: { color },
          data: s.points.map((p) => [p.polledAt, p.value]),
        };
      }),
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

  {#if lowData}
    <p class="chart-low-data-caption">{m.chart_low_data_caption()}</p>
  {/if}
</div>

<style>
  .event-history-chart {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .chart-low-data-caption {
    margin: 0;
    font-size: var(--t-12, 12px);
    font-style: italic;
    color: var(--text-3);
  }
</style>

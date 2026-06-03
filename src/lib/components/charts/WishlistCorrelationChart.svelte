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
  // ECharts (RESEARCH Pattern 4 + 04-12 HTML marker overlay):
  //   - one wishlist daily-balance LineChart series per listing (yAxis =
  //     abbreviate, D-11), named with the listing label for the legend. Each
  //     line is `smooth:true` with a subtle filled area beneath (a vertical
  //     gradient from the line's color → transparent; concrete rgba stops only —
  //     never a var()/color-mix string on the canvas).
  //   - a crosshair `trigger:'axis'` tooltip (line axisPointer) shows the
  //     hovered DATE + one row per visible listing (swatch + its wishlist value)
  //     so the user can inspect ANY day, including days WITHOUT events.
  //   - the EVENT markers are NO LONGER painted on the canvas. They live in an HTML
  //     overlay (<ChartMarkerOverlay>) absolutely-positioned over the plot area:
  //     each event-day is pixel-positioned via chart.convertToPixel, then chips
  //     within ~44px are MERGED into one cluster chip (kills the "Year" pile-up
  //     a canvas can't declutter-by-screen-distance). A preview event → an <img>
  //     thumbnail; a no-preview kind → a large <KindIcon> on a kind-colored
  //     tile; ≥40px tap target; cluster count badge; tap → onSelectCluster(days).
  //     Plain DOM, so it uses --k-*/--surface CSS tokens freely (not the canvas).
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
  import type { EChartsType } from "echarts/core";
  import { LineChart } from "echarts/charts";
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
    dayToLocalMs,
    tooltipEventsHtml,
    listingLabel as buildListingLabel,
    type ListingLite,
  } from "./wishlist-chart-shared.js";
  import type { EventDto, WishlistSeries, WishlistDelta } from "$lib/server/dto.js";

  use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

  let {
    seriesByListing,
    events,
    listings,
    today,
    range,
    visible,
    deltaByDate,
    onSelectCluster,
  }: {
    /** One wishlist series per active listing, keyed by listing id. */
    seriesByListing: Record<string, WishlistSeries>;
    events: EventDto[];
    /** Active listings (id + display name / appId) — drives line labels + order. */
    listings: ListingLite[];
    /** Server-chosen "now" ISO instant for the honest D-13 caption + range guard. */
    today: string;
    /** Shared date-range (owned by the page) — null = all time. CONTROLLED. */
    range: { from: Date; to: Date } | null;
    /** Shared legend selection (owned by the page): listingId → shown. CONTROLLED.
     *  Visibility is driven PURELY from this map — the series array is filtered
     *  by it (no ECharts legend round-trip), which is what fixes the re-enable
     *  bug. The custom <ChartLegend> at the page flips entries in this map. */
    visible: Record<string, boolean>;
    /** Per-listing, per-day wishlist delta (D-05): deltaByDate[listingId][day] =
     *  { delta24h, delta7d, windowFrom, windowTo }. Threaded from the page so the
     *  crosshair tooltip can show an event-day's post-event EFFECT line
     *  (the Paraglide-localized effect label + "+12 in 7d ↑" / "+3 in 24h") —
     *  the day-level delta (04-19, replacing the removed on-line highlight band). */
    deltaByDate: Record<string, Record<string, WishlistDelta>>;
    /** Marker (cluster) tap → the page (which owns the day-detail modal + feed
     *  data). The overlay merges nearby event-days into one chip and emits ALL
     *  the chip's days so the modal shows every event under it. */
    onSelectCluster: (days: string[]) => void;
  } = $props();

  // The live ECharts instance (svelte-echarts exposes it via `chart = $bindable()`).
  // The HTML marker overlay reads it to pixel-position + cluster the event chips.
  let chart = $state<EChartsType | undefined>();

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
  type Line = {
    id: string;
    label: string;
    color: string;
    points: { date: string; balance: number }[];
    lastImportedAt: string | null;
  };

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

  // A value that changes whenever the chart re-renders the markers' x positions:
  // the range window (axis domain), the visible-line set (re-layout), and the
  // day set. The overlay reads this to re-run its pixel-cluster layout. (The
  // chart's own 'finished' event + a ResizeObserver cover resize/zoom; this
  // covers prop-driven data/range/visibility changes.)
  const recomputeKey = $derived(
    JSON.stringify({
      d: domain,
      v: visible,
      lines: lines.map((l) => l.id),
      days: dayGroups.map((g) => g.date),
    }),
  );

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

  // Hex (#rrggbb / #rgb) → "r,g,b" for an rgba() gradient stop. The line colors
  // come from the concrete LINE_PALETTE (already hex), so no getComputedStyle is
  // needed here — but if a future palette entry is non-hex, fall back to a
  // neutral so the canvas never receives a var()/color-mix string it can't read.
  function hexToRgb(hex: string): string {
    const h = hex.trim().replace(/^#/, "");
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) return "120,120,120";
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `${r},${g},${b}`;
  }

  // A subtle, branded vertical area fill (04-18): the line's color at ~12% alpha
  // at the top fading to transparent at the bottom — lighter than the old ~18%
  // so the fill reads as a soft branded wash, not a heavy dark block. Concrete
  // rgba stops only (never a CSS var / color-mix on the canvas).
  function areaGradient(lineColor: string): {
    color: {
      type: "linear";
      x: number;
      y: number;
      x2: number;
      y2: number;
      colorStops: { offset: number; color: string }[];
    };
  } {
    const rgb = hexToRgb(lineColor);
    return {
      color: {
        type: "linear" as const,
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: `rgba(${rgb},0.12)` },
          { offset: 1, color: `rgba(${rgb},0)` },
        ],
      },
    };
  }

  // ── Crosshair axis tooltip (inspect any day, incl. empty days) ───────
  // trigger:'axis' + a line axisPointer shows the hovered DATE + one row per
  // VISIBLE listing (swatch color + that day's wishlist value, abbreviate). This
  // lets the user inspect ANY date — including days WITHOUT events (the user's
  // "can't select empty days"). The event markers are DOM chips now (the
  // overlay), so there's no on-canvas marker tooltip to fight this one.
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // YYYY-MM-DD (local) day key for the hovered axis value (ms on a time axis),
  // so it matches buildDayGroups' date keys (isoDay) and we can look up that
  // day's events for the tooltip.
  function axisValueToDay(axisValue: unknown): string | null {
    if (typeof axisValue !== "number" && typeof axisValue !== "string") return null;
    const d = new Date(axisValue);
    if (Number.isNaN(d.getTime())) return null;
    return isoDay(d);
  }

  // A signed delta with a direction arrow: "+12 ↑" / "-3 ↓" / "0 →"; null → "—".
  function signedDelta(value: number | null): string {
    if (value === null) return "—";
    const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value} ${arrow}`;
  }

  // The post-event EFFECT line for the hovered DAY (replaces the removed on-line
  // highlight band, 04-19): resolve that day's WishlistDelta across the visible
  // lines (first match — mirrors the page's per-day delta resolution) and render
  // the localized effect label + "<b>+12 in 7d ↑</b>" / "+3 in 24h" (Paraglide).
  // Only for an event-day that has a delta with at least one non-null window —
  // non-event days show nothing.
  function tooltipEffectHtml(day: string | null): string {
    if (!day) return "";
    let delta: WishlistDelta | null = null;
    for (const line of lines) {
      const d = deltaByDate[line.id]?.[day];
      if (d) {
        delta = d;
        break;
      }
    }
    if (!delta || (delta.delta7d === null && delta.delta24h === null)) return "";
    // Paraglide copy: the label + the "{value} in 7d" / "{value} in 24h" keys
    // (m.viz_wishlist_effect / m.viz_delta_7d / m.viz_delta_24h). The interpolated
    // value is signedDelta — a signed int + a direction arrow (safe), but escape
    // it anyway since it flows into innerHTML; the static Paraglide words need no
    // escaping. 7d and 24h read IDENTICALLY (same emphasis) on SEPARATE lines (the
    // user: on one row they blended together).
    return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(128,128,128,0.25);font-size:12px;">${escapeHtml(
      m.viz_wishlist_effect(),
    )}:<br><b>${escapeHtml(
      m.viz_delta_7d({ value: signedDelta(delta.delta7d) }),
    )}</b><br><b>${escapeHtml(m.viz_delta_24h({ value: signedDelta(delta.delta24h) }))}</b></div>`;
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
          // value is the [date, balance] tuple for a time-axis line series.
          const v = Array.isArray(p.value) ? p.value[1] : p.value;
          const num = typeof v === "number" ? abbreviate(v) : "—";
          const swatch = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${escapeHtml(String(p.color ?? "#888"))};margin-right:6px;"></span>`;
          return `<div style="display:flex;align-items:center;gap:8px;"><span>${swatch}${escapeHtml(String(p.seriesName ?? ""))}</span><span style="margin-left:auto;font-variant-numeric:tabular-nums;">${escapeHtml(num)}</span></div>`;
        })
        .join("");
      // Append the hovered day's EVENTS (thumbnail/dot + title) into the SAME
      // tooltip so hovering a day (or its dashed line) shows what happened.
      const day = axisValueToDay(params[0]?.axisValue);
      const eventsHtml = day
        ? tooltipEventsHtml(day, dayGroups, (count) => m.viz_marker_more({ count }))
        : "";
      // The post-event wishlist EFFECT line for an event-day with a delta (04-19).
      const effectHtml = tooltipEffectHtml(day);
      return `<div style="min-width:140px;max-width:260px;">${head}${rows}${eventsHtml}${effectHtml}</div>`;
    },
  }));

  // ── Click anywhere on the plot → the nearest event-day's modal ───────
  // The chips/lines own their own clicks (a chip = its cluster, a line = its
  // day). Empty-plot clicks fall through to the ZRender canvas (the overlay
  // CONTAINER is pointer-events:none): convert the click x-pixel to a date, find
  // the NEAREST event-day, and open its modal — so the user doesn't have to hit a
  // tiny chip. Guarded: no event-days → ignore; chip/line clicks already emitted
  // their selection and don't reach here (they stop at the overlay's buttons).
  function nearestDay(dateMs: number): string | null {
    if (dayGroups.length === 0) return null;
    let best: string | null = null;
    let bestDist = Infinity;
    for (const g of dayGroups) {
      // LOCAL-midnight ms (dayToLocalMs) so the distance is measured against the
      // SAME axis coordinate the line/markers use (convertFromPixel returns the
      // local-midnight-based axis ms now that the series feed dayToLocalMs).
      const t = dayToLocalMs(g.date);
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

  // ── ECharts option (client-only — resolves --k-* tokens) ─────────────
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();

    // One LineChart series per visible listing — smooth (Millo-style) with a
    // subtle filled area beneath (a vertical gradient from the line's RESOLVED
    // color → transparent). Concrete rgba stops only — never a var()/color-mix
    // string the ECharts canvas can't resolve.
    const lineSeries = lines.map((line) => ({
      name: line.label,
      type: "line" as const,
      smooth: true,
      showSymbol: false,
      symbolSize: 14, // D-10 tap-friendly hit target at narrow widths.
      lineStyle: { width: 2, color: line.color },
      itemStyle: { color: line.color },
      areaStyle: areaGradient(line.color),
      // dayToLocalMs(p.date): feed the LOCAL-midnight ms (NOT the bare
      // "YYYY-MM-DD" string, which the time axis parses as UTC midnight → a
      // day-early render in a negative-offset TZ). The crosshair tooltip reads
      // value[1] for the balance, so the [ms, balance] tuple shape is unchanged.
      data: line.points.map((p) => [dayToLocalMs(p.date), p.balance]),
    }));

    // D-08: no listing has points → an empty anchor series keeps the grid drawn
    // so the event chips (DOM overlay) sit over a real plot area.
    const anchorSeries = {
      name: "__wishlist_anchor__",
      type: "line" as const,
      showSymbol: false,
      data: [] as [string, number][],
    };

    return {
      ...baseChartOptions({ reducedMotion }),
      tooltip: crosshairTooltip,
      // No ECharts native legend — the custom on-brand <ChartLegend> at the page
      // drives per-listing visibility via the shared `visible` map (04-09).
      // FIXED grid geometry (shared constant, containLabel:false) so a date maps
      // to the SAME x-pixel here as on the growth chart → the two DOM overlays
      // cluster event-days IDENTICALLY (04-14). containLabel:true would size the
      // left inset to THIS chart's wider balance labels and shift the clusters.
      grid: WISHLIST_CHART_GRID,
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
        // Label the Y-axis unit (#6) so the numbers have meaning. A concrete
        // muted rgba (NEVER a var()/color-mix the canvas can't resolve); sits
        // above the axis (nameLocation:"end") with a small gap so it doesn't clip.
        name: m.viz_axis_wishlists(),
        nameLocation: "end" as const,
        nameGap: 12,
        nameTextStyle: { color: "rgba(148,148,148,0.85)", fontSize: 11, align: "left" as const },
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

  <!-- Height-reserving wrapper OUTSIDE the typeof-window gate (04-18): the slot
       keeps its 300px height on SSR + before mount, so the chart can't pop in /
       jump the layout (no CLS). A subtle skeleton placeholder fills it until the
       client <Chart> instance mounts. -->
  <div class="chart-canvas">
    {#if typeof window !== "undefined"}
      <!-- Relatively-positioned wrapper so the absolutely-positioned HTML marker
           overlay lays its event chips OVER the chart's plot area. -->
      <Chart {init} {options} bind:chart />
      <ChartMarkerOverlay {chart} {dayGroups} {recomputeKey} {onSelectCluster} />
    {/if}
    {#if !chart}
      <!-- Skeleton placeholder: a muted box until the client chart mounts. The
           shimmer is gated off under prefers-reduced-motion (static box only). -->
      <div class="chart-skeleton" data-testid="chart-skeleton" aria-hidden="true"></div>
    {/if}
  </div>

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
    position: relative;
    width: 100%;
    height: 300px;
    min-width: 0;
    font-variant-numeric: tabular-nums;
    /* Affordance (04-18): the whole plot is click-anywhere (a click opens the
     * nearest event-day's modal), so signal it's interactive. */
    cursor: pointer;
  }
  /* Loading skeleton (04-18): a muted box filling the reserved chart height
   * until the client chart mounts, so there's no flash/jump on load. A subtle
   * shimmer sweeps across it; disabled under prefers-reduced-motion. */
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

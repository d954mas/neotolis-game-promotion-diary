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
  // ECharts (RESEARCH Pattern 4 + 04-11 Millo-style thumbnail markers):
  //   - one wishlist daily-balance LineChart series per listing (yAxis =
  //     abbreviate, D-11), named with the listing label for the legend.
  //   - markPoint.data = one ≈40px THUMBNAIL preview marker per DISTINCT
  //     event-DAY (eventThumbnail → YouTube/Reddit preview image, fallback a
  //     kind-colored placeholder disc via resolveKindColor; mixed-kind day →
  //     neutral --k-post, D-04). >1 event that day → a count badge "N" (D-04).
  //     The markers sit in a row at a TOP band above the line and attach to the
  //     FIRST visible listing series (or a hidden anchor series when no listing
  //     has points) so they render against the grid regardless of legend
  //     toggles. The 40px size is the tap target that fixes touch (VIZ-04).
  //   - hover a marker → a tooltip with the preview thumbnail + the event count
  //     + the first titles (Millo "preview + count"). No on-chart markArea
  //     highlight: its color was an unresolved color-mix(var(--accent)) the
  //     canvas rendered as a gray square and never cleared — removed in 04-11;
  //     the centered modal already shows the day's delta.
  //   - click a marker → emit onSelectDay(day) up to the PAGE, which owns the
  //     centered EventDayModal (day stats + the day's events as FeedCards).
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
    MarkPointComponent,
  } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  import type { ECMouseEvent } from "svelte-echarts";
  import { m } from "$lib/paraglide/messages.js";
  import { abbreviate } from "./abbreviate.js";
  import { baseChartOptions, prefersReducedMotion } from "./chart-theme.js";
  import {
    listingColor,
    inRange,
    buildDayGroups,
    buildMarkPointData,
    eventThumbnail,
    axisDomain,
    listingLabel as buildListingLabel,
    type DayGroup,
    type ListingLite,
  } from "./wishlist-chart-shared.js";
  import type { EventDto, WishlistSeries } from "$lib/server/dto.js";

  use([
    LineChart,
    GridComponent,
    TooltipComponent,
    MarkPointComponent,
    CanvasRenderer,
  ]);

  let {
    seriesByListing,
    events,
    listings,
    today,
    range,
    visible,
    onSelectDay,
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
    /** Marker click → the page (which owns the day-detail modal + feed data). */
    onSelectDay: (day: string) => void;
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

  // Anchor series name for the D-08 empty-state (no listing has points) — the
  // markPoint markers attach to it so they still render against the grid.
  const markPointSeriesName = $derived(lines[0]?.label ?? "__wishlist_anchor__");

  // markPoint click → emit the day up to the page (which owns the centered
  // EventDayModal). ECharts fires the chart-level 'click' with componentType
  // 'markPoint'; the marker carries its day in `name`/`value` (set on each
  // markPoint datum by buildMarkPointData). NOTE: the old markArea highlight
  // (and its local selectedDay state) is intentionally gone — its color was an
  // unresolved `color-mix(var(--accent))` that the canvas rendered as a gray
  // square and never cleared. The modal already shows the day's delta, so the
  // on-chart highlight is redundant.
  function onChartClick(e: ECMouseEvent): void {
    if (e.componentType !== "markPoint") return;
    const day = (e.data as { name?: string } | undefined)?.name;
    if (typeof day === "string") onSelectDay(day);
  }

  // The y-band the thumbnail markers sit on: a row hugging the TOP of the grid,
  // ABOVE the wishlist line. Derived from the max balance across visible lines
  // (so the band scales with the data); a small constant when there are no
  // points (D-08) keeps the markers near the top of the empty grid.
  const markerBand = $derived.by((): number => {
    let max = 0;
    for (const line of lines) {
      for (const p of line.points) if (p.balance > max) max = p.balance;
    }
    // ~8% headroom above the peak so the 40px thumbnails clear the line.
    return max > 0 ? max * 1.08 : 1;
  });

  // ── Hover preview tooltip (Task 3 — Millo "preview + count") ──────────
  // Day-keyed lookup so the markPoint tooltip formatter can resolve the day's
  // group (thumbnail + count + first titles) from the hovered marker's `name`.
  const dayGroupByDate = $derived.by((): Map<string, DayGroup> => {
    const map = new Map<string, DayGroup>();
    for (const g of dayGroups) map.set(g.date, g);
    return map;
  });

  // HTML-escape titles before injecting them into the tooltip HTML string
  // (ECharts renders the formatter return as innerHTML).
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // markPoint-only tooltip: hovering a thumbnail shows the preview image, the
  // event count ("N событий"), and the first up-to-3 titles (+K more). The
  // wishlist line itself gets no hover tooltip (trigger:'item' + the formatter
  // returns "" for non-markPoint items) so the line hover stays quiet.
  const markerTooltip = $derived.by(() => ({
    trigger: "item" as const,
    enterable: false,
    confine: true,
    formatter: (raw: unknown): string => {
      // ECharts hands a single CallbackDataParams for item-trigger; narrow the
      // shape we read (componentType + name) without depending on its wide union.
      const params = (Array.isArray(raw) ? raw[0] : raw) as
        | { componentType?: string; name?: string }
        | undefined;
      if (!params || params.componentType !== "markPoint") return "";
      const g = typeof params.name === "string" ? dayGroupByDate.get(params.name) : undefined;
      if (!g) return "";
      const thumb = eventThumbnail(g.events[0]!);
      const img = thumb
        ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(m.viz_marker_preview_alt())}" style="width:120px;height:auto;border-radius:6px;display:block;margin-bottom:6px;" />`
        : "";
      const count = `<div style="font-weight:600;margin-bottom:2px;">${escapeHtml(m.viz_marker_event_count({ count: g.events.length }))}</div>`;
      const shown = g.events.slice(0, 3);
      const titles = shown
        .map((e) => `<div style="opacity:.85;">${escapeHtml(e.title)}</div>`)
        .join("");
      const moreCount = g.events.length - shown.length;
      const more =
        moreCount > 0
          ? `<div style="opacity:.6;">${escapeHtml(m.viz_marker_more({ count: moreCount }))}</div>`
          : "";
      return `<div style="max-width:160px;">${img}${count}${titles}${more}</div>`;
    },
  }));

  // ── ECharts option (client-only — resolves --k-* tokens) ─────────────
  const options = $derived.by(() => {
    if (typeof window === "undefined") return {};
    const reducedMotion = prefersReducedMotion();

    // Millo-style THUMBNAIL preview markers: one ≈40px image markPoint per
    // distinct event-DAY, sitting in a row at the TOP band above the line, with
    // a count badge "N" for multi-event days. Shared resolver (eventThumbnail)
    // so a marker shows the SAME preview the FeedCard does. Replaces the old
    // thin vertical markLine (the user kept pointing at the competitor's
    // thumbnail markers); the 40px size also fixes the poor touch interaction.
    const markPointData = buildMarkPointData(dayGroups, markerBand);

    const markPoint = {
      silent: false,
      // Markers render even with an empty wishlist series (D-08).
      data: markPointData,
    };

    // One LineChart series per visible listing. The FIRST series carries the
    // shared markPoint markers so they read against the grid regardless of which
    // lines the legend toggles off (markers are date-keyed + shared).
    const lineSeries = lines.map((line, i) => ({
      name: line.label,
      type: "line" as const,
      showSymbol: false,
      symbolSize: 14, // D-10 tap-friendly hit target at narrow widths.
      lineStyle: { width: 2, color: line.color },
      itemStyle: { color: line.color },
      data: line.points.map((p) => [p.date, p.balance]),
      ...(i === 0 ? { markPoint } : {}),
    }));

    // D-08: no listing has points → a hidden anchor series carries the markPoint
    // markers so the event thumbnails still render against the grid.
    const anchorSeries = {
      name: markPointSeriesName,
      type: "line" as const,
      showSymbol: false,
      data: [] as [string, number][],
      markPoint,
    };

    return {
      ...baseChartOptions({ reducedMotion }),
      tooltip: markerTooltip,
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
      <Chart {init} {options} onclick={onChartClick} />
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

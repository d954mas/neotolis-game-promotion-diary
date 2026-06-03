<script lang="ts">
  // ChartMarkerOverlay — 04-12 replacement for the canvas markPoint thumbnails.
  //
  // UAT round-1 root cause: ECharts canvas `markPoint`s can't declutter by
  // SCREEN distance (selecting "Year" piled every thumbnail into the right ~5%
  // of the plot, overlapping unreadably) and can't render borders / rounded
  // corners / inline icons (no-preview kinds rendered as flat colored discs).
  //
  // Fix: render the event markers as an absolutely-positioned HTML layer OVER
  // the chart's plot area. Because it's plain DOM (NOT the canvas) it can:
  //   1. PIXEL-CLUSTER — position each event-day at its x-pixel
  //      (`chart.convertToPixel({xAxisIndex:0}, day)`), then greedily MERGE any
  //      chips whose centers are within ~44px into ONE cluster chip carrying all
  //      member days + events, with a combined count badge. This kills the
  //      "Year" pile-up: a year of events collapses to a few tidy chips.
  //   2. Render QUALITY chips — a ≥40px rounded tile with a kind-colored border;
  //      a preview event shows its `<img>` thumbnail, a no-preview event shows a
  //      LARGE <KindIcon> on a kind-colored tile. ≥40px = the touch tap target.
  //
  // Positioning is recomputed on `chart.on('finished')` (every render/resize/
  // dataZoom settle), a ResizeObserver on the chart container, and whenever the
  // `dayGroups`/`recomputeKey` props change (range/visibility/data).
  //
  // The overlay is plain DOM, so it uses CSS tokens (--k-*, --surface-2,
  // --border, --r-*) FREELY — the canvas-only "no var()/color-mix" rule does NOT
  // apply here (that rule is about strings the ECharts canvas can't resolve).
  //
  // Tap/Enter → onSelectCluster(cluster.days) → the page opens the centered
  // EventDayModal with ALL the cluster's events. Hover → a small preview tooltip
  // (representative thumbnail/icon + count + first titles).

  import KindIcon from "$lib/components/KindIcon.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { eventThumbnail, markerDayLabel, type DayGroup } from "./wishlist-chart-shared.js";
  import type { EChartsType } from "echarts/core";
  import type { EventDto } from "$lib/server/dto.js";

  // Kind → CSS var bridge (DOM-side, so var() is fine here). Mirrors
  // ActiveFiltersStrip's KIND_ACCENT_VAR so a chip's border reads the same hue
  // as the rest of the app's kind vocabulary. Mixed-kind cluster → --k-post.
  const KIND_ACCENT_VAR: Record<string, string> = {
    youtube_video: "var(--k-youtube)",
    reddit_post: "var(--k-reddit)",
    twitter_post: "var(--k-twitter)",
    telegram_post: "var(--k-telegram)",
    discord_drop: "var(--k-discord)",
    conference: "var(--k-conference)",
    talk: "var(--k-talk)",
    press: "var(--k-press)",
    post: "var(--k-post)",
    other: "var(--k-other)",
  };

  function kindAccent(kind: string): string {
    return KIND_ACCENT_VAR[kind] ?? "var(--k-post)";
  }

  // A YYYY-MM-DD event-day → a compact "May 27" label for a per-day line's
  // aria-label. Same en short-month format as markerDayLabel (host-locale-stable
  // for CI). Parsed as a local date (append T00:00) so the day doesn't shift.
  function dayLabel(day: string): string {
    const d = new Date(day + "T00:00:00");
    if (Number.isNaN(d.getTime())) return day;
    return d.toLocaleDateString("en", { month: "short", day: "numeric" });
  }

  // The KindIcon component only knows a fixed kind union; fall back to "post"
  // for anything outside it so a no-preview chip always renders an icon.
  type IconKind =
    | "youtube_video"
    | "reddit_post"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";
  const ICON_KINDS = new Set<string>([
    "youtube_video",
    "reddit_post",
    "twitter_post",
    "telegram_post",
    "discord_drop",
    "conference",
    "talk",
    "press",
    "other",
    "post",
  ]);
  function iconKind(kind: string): IconKind {
    return (ICON_KINDS.has(kind) ? kind : "post") as IconKind;
  }

  let {
    chart,
    dayGroups,
    recomputeKey,
    onSelectCluster,
  }: {
    /** The live ECharts instance (bound from <Chart bind:chart>). null until mount. */
    chart: EChartsType | null | undefined;
    /** Distinct event-days (already range-filtered, date-ASC) from buildDayGroups. */
    dayGroups: DayGroup[];
    /** Any value that changes when the chart's range/visibility/data changes —
     *  re-runs the pixel layout (the chart re-renders, so positions move). */
    recomputeKey: unknown;
    /** Tap a chip → emit ALL its member days up to the page (cluster modal). */
    onSelectCluster: (days: string[]) => void;
  } = $props();

  // ── Pixel collision clustering ───────────────────────────────────────────
  // Merge threshold in CSS px: chips whose CENTERS are closer than this collapse
  // into one cluster. 44px ≈ the chip tap-target width, so merged chips never
  // visually overlap.
  const CLUSTER_PX = 44;
  // The y-band the chips sit in: a row hugging the TOP of the plot area.
  const TOP_BAND_PX = 8;
  // Chip side length (px) — the dashed guide line starts just below the chip.
  const CHIP_PX = 40;

  type Cluster = {
    /** Center x in CSS px within the chart container. */
    x: number;
    /** All member days (date-ASC) — emitted to onSelectCluster. */
    days: string[];
    /** All member events, flattened across the member days. */
    events: DayGroup["events"];
    /** Representative kind (most-recent day's kind) for the border color. */
    kind: string;
    /** True when the cluster spans more than one kind → neutral --k-post. */
    mixedKind: boolean;
  };

  // One per EVENT-DAY: its x-pixel + the kind that colors its dashed guide line.
  // The per-day dashed lines are drawn from THIS list (every event-day gets its
  // own clickable line) — NOT from `clusters` (which only positions the merged
  // thumbnail cards). Splitting the two is the UAT fix: a day whose card merged
  // into a neighbour's still has its own line and is directly selectable.
  type DayPixel = {
    /** The event-day (YYYY-MM-DD) this line marks. */
    day: string;
    /** Center x in CSS px within the chart container. */
    x: number;
    /** Day kind (most-recent event's kind) → the line color. */
    kind: string;
    /** True when the day itself spans more than one kind → neutral --k-post. */
    mixedKind: boolean;
  };

  // The computed clusters, recomputed imperatively (the chart instance + its
  // pixel geometry aren't reactive). `version` bumps to force the markup to
  // re-read `clusters` after each layout pass.
  let clusters = $state<Cluster[]>([]);
  // Per-event-day dashed guide lines (one per day with events).
  let dayPixels = $state<DayPixel[]>([]);
  // The plot area's BOTTOM y-pixel (the dashed guide line drops from a chip down
  // to here — the axis). Computed from the grid's coordinate-system rect each
  // layout pass; 0 until the chart is built (no line drawn yet).
  let plotBottom = $state(0);
  // Track which cluster is hovered for the preview tooltip.
  let hoveredIndex = $state<number | null>(null);

  // The grid coordinate system exposes its plot-area rect via getRect(). It's
  // not in the public typings, so reach it through a narrow structural type and
  // guard every hop — on a not-yet-built chart we fall back to the chart height
  // minus a conservative bottom inset (the grid's `bottom:36` + axis labels) so
  // the line still lands near the axis rather than overshooting.
  type GridRect = { y: number; height: number };
  type GridModel = { coordinateSystem?: { getRect?: () => GridRect } };
  type ModelHost = { getModel?: () => { getComponent?: (t: string, i: number) => GridModel } };
  function computePlotBottom(c: EChartsType): number {
    try {
      const grid = (c as unknown as ModelHost).getModel?.()?.getComponent?.("grid", 0);
      const rect = grid?.coordinateSystem?.getRect?.();
      if (rect && typeof rect.y === "number" && typeof rect.height === "number") {
        return rect.y + rect.height;
      }
    } catch {
      /* coordinate system not built yet — fall through to the height estimate */
    }
    return Math.max(0, c.getHeight() - 56);
  }

  function recompute(): void {
    const c = chart;
    // Guard a disposed instance: 'finished'/ResizeObserver can fire after the
    // <Chart> tears the ECharts instance down (unmount/HMR), and convertToPixel
    // throws on a disposed chart. isDisposed() is the official guard.
    if (!c || c.isDisposed() || dayGroups.length === 0) {
      clusters = [];
      dayPixels = [];
      plotBottom = 0;
      return;
    }

    // The plot area's bottom edge in CSS px = the grid coordinate system's
    // rect.y + rect.height. The dashed guide line drops from each chip down to
    // here (the x-axis), so a marker reads as "this date" across the whole plot.
    // getModel()/getComponent are ECharts' stable accessors; guard the whole
    // chain in case the coordinate system isn't built yet (re-runs next pass).
    plotBottom = computePlotBottom(c);

    // Position each day at its x-pixel; drop days that fall outside the grid
    // (convertToPixel returns NaN for out-of-domain values on some builds).
    // convertToPixel throws if the xAxis coordinate system isn't built yet (an
    // empty series before the first 'finished' fires) — bail and wait for the
    // next 'finished'/resize pass rather than crash the effect.
    type Placed = { x: number; group: DayGroup };
    const placed: Placed[] = [];
    let convertReady = true;
    for (const g of dayGroups) {
      let x: number | null;
      try {
        const px = c.convertToPixel({ xAxisIndex: 0 }, g.date);
        x = Array.isArray(px) ? px[0]! : px;
      } catch {
        convertReady = false;
        break;
      }
      if (typeof x !== "number" || Number.isNaN(x)) continue;
      placed.push({ x, group: g });
    }
    if (!convertReady) {
      clusters = [];
      dayPixels = [];
      return;
    }
    placed.sort((a, b) => a.x - b.x);

    // ── Per-day dashed lines ──────────────────────────────────────────────
    // One line per event-day at its own x-pixel, colored by that day's kind.
    // These are independent of clustering: even when two days' CARDS merge,
    // each day keeps its own line (so the user can select the merged-away day).
    dayPixels = placed.map(({ x, group }): DayPixel => {
      const kinds = new Set(group.events.map((e) => e.kind));
      const mixedKind = kinds.size > 1;
      return { day: group.date, x, kind: mixedKind ? "post" : group.kind, mixedKind };
    });

    // Greedy merge: walk left→right, extend the current cluster while the next
    // day's x is within CLUSTER_PX of the cluster's running center.
    const out: Cluster[] = [];
    let cur: { xs: number[]; groups: DayGroup[] } | null = null;
    const flush = (): void => {
      if (!cur) return;
      const groups = cur.groups;
      const days = groups.map((g) => g.date);
      const events = groups.flatMap((g) => g.events);
      const kinds = new Set(events.map((e) => e.kind));
      const mixedKind = kinds.size > 1;
      // Representative kind = the most-recent member day's kind (groups are
      // date-ASC, so the last one).
      const kind = mixedKind ? "post" : groups[groups.length - 1]!.kind;
      // Card x = the CENTROID (average) of its member days' x-pixels, so a
      // merged thumbnail card sits CENTERED between its days' dashed lines —
      // not offset to the first/leftmost day.
      const centroid = cur.xs.reduce((s, v) => s + v, 0) / cur.xs.length;
      const x = centroid;
      out.push({ x, days, events, kind, mixedKind });
      cur = null;
    };
    for (const p of placed) {
      if (cur === null) {
        cur = { xs: [p.x], groups: [p.group] };
        continue;
      }
      const center = cur.xs.reduce((s, v) => s + v, 0) / cur.xs.length;
      if (Math.abs(p.x - center) <= CLUSTER_PX) {
        cur.xs.push(p.x);
        cur.groups.push(p.group);
      } else {
        flush();
        cur = { xs: [p.x], groups: [p.group] };
      }
    }
    flush();
    clusters = out;
  }

  // Wire the recompute triggers: the chart's 'finished' event (fires after every
  // render/resize/zoom settle) + a ResizeObserver on its container + the
  // reactive recomputeKey. Re-bind when the chart instance changes.
  $effect(() => {
    const c = chart;
    if (!c) {
      clusters = [];
      dayPixels = [];
      return;
    }
    const onFinished = (): void => recompute();
    c.on("finished", onFinished);

    const dom = c.getDom();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(dom);

    // Initial pass (the chart may already be rendered when we mount).
    recompute();

    return () => {
      c.off("finished", onFinished);
      ro.disconnect();
    };
  });

  // Recompute whenever the inputs that move markers change (range filter toggles
  // the day set; legend visibility re-renders the chart). Reading both here
  // makes this effect depend on them.
  $effect(() => {
    void dayGroups;
    void recomputeKey;
    recompute();
  });

  // Representative event for a cluster's thumbnail/icon = the first event of the
  // most-recent member day.
  function representativeEvent(cl: Cluster): DayGroup["events"][number] {
    return cl.events[cl.events.length - 1]!;
  }

  function thumbFor(cl: Cluster): string | null {
    return eventThumbnail(representativeEvent(cl));
  }

  // ── Rich tooltip rows ────────────────────────────────────────────────────
  // The hover tooltip lists EACH event in the cluster as a row: its thumbnail
  // (or a KindIcon when no preview) + title + its DAY. A merged 27–28 cluster
  // therefore reveals BOTH days' events distinctly on hover (the user can see
  // the 27th even though it collapsed into the 28th's chip). Cap the rows so a
  // huge cluster doesn't overflow the viewport; the rest fold into "+K more".
  const MAX_TOOLTIP_ROWS = 6;
  type TooltipRow = { id: string; thumb: string | null; kind: string; title: string; day: string };

  function tooltipRows(cl: Cluster): { rows: TooltipRow[]; more: number } {
    const all = cl.events.map(
      (e: EventDto): TooltipRow => ({
        id: e.id,
        thumb: eventThumbnail(e),
        kind: e.kind,
        title: e.title,
        day: markerDayLabel(e),
      }),
    );
    const rows = all.slice(0, MAX_TOOLTIP_ROWS);
    return { rows, more: all.length - rows.length };
  }
</script>

<div class="marker-overlay" aria-hidden={clusters.length === 0}>
  <!-- Per-DAY dashed guide lines: one per event-day at its own x-pixel, colored
       by that day's kind, dropping from the chip band to the plot bottom (the
       x-axis). Each line is wrapped in a thin (~10px) TRANSPARENT clickable strip
       (a button) → onSelectCluster([day]) opens just that single day. So every
       event-day is marked AND directly selectable even when its thumbnail card
       merged into a neighbour's (the 27th stays selectable next to the 28th). -->
  {#if plotBottom > TOP_BAND_PX + CHIP_PX}
    {#each dayPixels as dp (dp.day)}
      {@const dayAccent = kindAccent(dp.kind)}
      <button
        type="button"
        class="marker-guide-hit"
        data-testid="chart-marker-guide-hit"
        style={`left:${dp.x}px; top:${TOP_BAND_PX + CHIP_PX}px; height:${plotBottom - TOP_BAND_PX - CHIP_PX}px;`}
        aria-label={m.viz_marker_day_select({ day: dayLabel(dp.day) })}
        onclick={() => onSelectCluster([dp.day])}
      >
        <span
          class="marker-guide"
          aria-hidden="true"
          data-testid="chart-marker-guide"
          style={`--chip-accent:${dayAccent};`}
        ></span>
      </button>
    {/each}
  {/if}

  {#each clusters as cl, i (cl.days.join(",") + ":" + cl.x)}
    {@const thumb = thumbFor(cl)}
    {@const accent = kindAccent(cl.kind)}
    {@const tt = tooltipRows(cl)}
    <button
      type="button"
      class="marker-chip"
      class:mixed={cl.mixedKind}
      style={`left:${cl.x}px; top:${TOP_BAND_PX}px; --chip-accent:${accent};`}
      data-testid="chart-marker-chip"
      aria-label={m.viz_marker_event_count({ count: cl.events.length })}
      onclick={() => onSelectCluster(cl.days)}
      onmouseenter={() => (hoveredIndex = i)}
      onmouseleave={() => (hoveredIndex = null)}
      onfocus={() => (hoveredIndex = i)}
      onblur={() => (hoveredIndex = null)}
    >
      {#if thumb}
        <img class="chip-thumb" src={thumb} alt={m.viz_marker_preview_alt()} loading="lazy" />
      {:else}
        <span class="chip-icon">
          <KindIcon kind={iconKind(cl.kind)} size={28} />
        </span>
      {/if}

      {#if cl.events.length > 1}
        <span class="chip-count" data-testid="chart-marker-count">{cl.events.length}</span>
      {/if}

      {#if hoveredIndex === i}
        <!-- Rich preview tooltip: one row PER event (thumbnail/KindIcon + title
             + day), so a merged multi-day cluster reveals both days distinctly.
             role=tooltip; pointer-events:none so it never steals the hover. -->
        <span class="chip-tooltip" role="tooltip" data-testid="chart-marker-tooltip">
          <span class="tt-count">{m.viz_marker_event_count({ count: cl.events.length })}</span>
          {#each tt.rows as row (row.id)}
            <span class="tt-row">
              {#if row.thumb}
                <img
                  class="tt-thumb"
                  src={row.thumb}
                  alt={m.viz_marker_preview_alt()}
                  loading="lazy"
                />
              {:else}
                <span class="tt-icon"><KindIcon kind={iconKind(row.kind)} size={20} /></span>
              {/if}
              <span class="tt-text">
                <span class="tt-title">{row.title}</span>
                <span class="tt-day">{row.day}</span>
              </span>
            </span>
          {/each}
          {#if tt.more > 0}
            <span class="tt-more">{m.viz_marker_more({ count: tt.more })}</span>
          {/if}
        </span>
      {/if}
    </button>
  {/each}
</div>

<style>
  /* The overlay sits over the chart's plot area; pointer-events:none lets chart
   * hover (the crosshair tooltip) pass through the gaps between chips, while
   * each chip re-enables its own pointer events. */
  .marker-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }

  /* Per-day clickable hit strip: a ~10px-wide TRANSPARENT button centered on the
   * day's x-pixel (translateX(-50%)), spanning the plot height. It re-enables
   * pointer events so tapping anywhere on (or near) the dashed line selects that
   * single day. left/top/height are set inline (the pixel layout). */
  .marker-guide-hit {
    position: absolute;
    width: 10px;
    padding: 0;
    border: 0;
    background: transparent;
    transform: translateX(-50%);
    cursor: pointer;
    pointer-events: auto;
    z-index: 1;
    display: flex;
    justify-content: center;
  }
  .marker-guide-hit:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }

  /* The dashed vertical line itself: a 1.5px dashed border centered inside the
   * hit strip, dropping to the plot bottom. Low opacity so it guides the eye to
   * the axis without competing with the wishlist line. */
  .marker-guide {
    width: 0;
    height: 100%;
    border-left: 1.5px dashed var(--chip-accent, var(--k-post));
    opacity: 0.4;
    pointer-events: none;
  }
  @media (hover: hover) {
    .marker-guide-hit:hover .marker-guide {
      opacity: 0.7;
    }
  }

  /* A ≥40px rounded tile with a kind-colored border. left/top are set inline
   * (the pixel layout); translateX(-50%) centers the chip on its x-pixel. */
  .marker-chip {
    position: absolute;
    transform: translateX(-50%);
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: var(--r-md);
    border: 2px solid var(--chip-accent, var(--k-post));
    background: var(--surface-2);
    box-shadow: var(--shadow-card);
    cursor: pointer;
    pointer-events: auto;
    overflow: visible;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      transform var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease);
  }
  @media (hover: hover) {
    .marker-chip:hover {
      transform: translateX(-50%) translateY(-2px);
      box-shadow: var(--shadow-elev);
    }
  }
  .marker-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Preview thumbnail fills the tile, rounded to match the border radius. */
  .chip-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: calc(var(--r-md) - 2px);
    display: block;
  }

  /* No-preview kind → a large KindIcon centered on a kind-colored tile. The
   * tile fill is a soft wash of the accent so the geometric icon reads. */
  .chip-icon {
    width: 100%;
    height: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: calc(var(--r-md) - 2px);
    background: color-mix(in oklab, var(--chip-accent, var(--k-post)) 22%, var(--surface-2));
    color: var(--chip-accent, var(--k-post));
  }
  .chip-icon :global(svg.kind) {
    color: inherit;
  }

  /* Combined count badge for clusters (>1 event), top-right. */
  .chip-count {
    position: absolute;
    top: -7px;
    right: -7px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-pill);
    background: var(--chip-accent, var(--k-post));
    color: #fff;
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-sb);
    line-height: 1;
    font-variant-numeric: tabular-nums;
    box-shadow: 0 0 0 2px var(--surface-2);
  }

  /* Hover/focus preview tooltip: a rich list — one row PER event (thumbnail or
   * KindIcon + title + day) — anchored below the chip. "В тултипе много места":
   * wider than the old count+titles panel so each event reads clearly. */
  .chip-tooltip {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    min-width: 220px;
    max-width: 300px;
    padding: var(--s-2) var(--s-3);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-elev);
    z-index: 4;
    pointer-events: none;
  }
  .tt-count {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  /* One event row: thumbnail/icon on the left, title + day stacked on the right. */
  .tt-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }
  .tt-thumb {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    object-fit: cover;
    border-radius: var(--r-sm);
    display: block;
  }
  .tt-icon {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text-2);
  }
  .tt-icon :global(svg.kind) {
    color: inherit;
  }
  .tt-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .tt-title {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tt-day {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .tt-more {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
  }

  @media (prefers-reduced-motion: reduce) {
    .marker-chip {
      transition: none;
    }
    @media (hover: hover) {
      .marker-chip:hover {
        transform: translateX(-50%);
      }
    }
  }
</style>

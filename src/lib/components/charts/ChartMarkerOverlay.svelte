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
  import { eventThumbnail, type DayGroup } from "./wishlist-chart-shared.js";
  import type { EChartsType } from "echarts/core";

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

  // The computed clusters, recomputed imperatively (the chart instance + its
  // pixel geometry aren't reactive). `version` bumps to force the markup to
  // re-read `clusters` after each layout pass.
  let clusters = $state<Cluster[]>([]);
  // Track which cluster is hovered for the preview tooltip.
  let hoveredIndex = $state<number | null>(null);

  function recompute(): void {
    const c = chart;
    // Guard a disposed instance: 'finished'/ResizeObserver can fire after the
    // <Chart> tears the ECharts instance down (unmount/HMR), and convertToPixel
    // throws on a disposed chart. isDisposed() is the official guard.
    if (!c || c.isDisposed() || dayGroups.length === 0) {
      clusters = [];
      return;
    }

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
      return;
    }
    placed.sort((a, b) => a.x - b.x);

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
      const x = cur.xs.reduce((s, v) => s + v, 0) / cur.xs.length;
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

  function titlesFor(cl: Cluster): { shown: string[]; more: number } {
    const titles = cl.events.map((e) => e.title);
    const shown = titles.slice(0, 3);
    return { shown, more: titles.length - shown.length };
  }
</script>

<div class="marker-overlay" aria-hidden={clusters.length === 0}>
  {#each clusters as cl, i (cl.days.join(",") + ":" + cl.x)}
    {@const thumb = thumbFor(cl)}
    {@const accent = kindAccent(cl.kind)}
    {@const titles = titlesFor(cl)}
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
        <span class="chip-tooltip" role="tooltip">
          <span class="tt-count">{m.viz_marker_event_count({ count: cl.events.length })}</span>
          {#each titles.shown as t (t)}
            <span class="tt-title">{t}</span>
          {/each}
          {#if titles.more > 0}
            <span class="tt-more">{m.viz_marker_more({ count: titles.more })}</span>
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

  /* Hover/focus preview tooltip: count + first titles, anchored below the chip. */
  .chip-tooltip {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    min-width: 140px;
    max-width: 220px;
    padding: var(--s-2) var(--s-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-elev);
    z-index: 3;
    pointer-events: none;
  }
  .tt-count {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .tt-title {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

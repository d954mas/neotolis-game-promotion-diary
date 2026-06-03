/**
 * VIZ-03 / VIZ-04 — chart reflow + the 04-10 interaction redesign (centered day
 * modal + feed-style preset picker + off-window event markers) + the 04-12 HTML
 * marker overlay (pixel collision clustering, kind-bordered chips, area/smooth/
 * crosshair, Steam mini-chart removed).
 *
 * ECharts paints to canvas (not DOM-introspectable), so the chart-internal bits
 * assert the WRAPPER / structure + data-attributes, not canvas internals:
 *   - the WishlistCorrelationChart container reflows (fits its column, no
 *     horizontal overflow) at 360px AND 600px viewport widths — VIZ-04 / D-10;
 *   - event markers derive from the events even when the events fall OUTSIDE
 *     the wishlist date span (04-10 union-domain fix) — data-marker-count;
 *   - the no-CSV empty-state CTA renders while markers still render — D-08;
 *   - the marker-tap surface is now a CENTERED EventDayModal (stats header +
 *     FeedCard list), NOT the old docked drawer/sheet (04-10);
 *   - the chart date control is the feed's DateRangeRow preset picker with the
 *     sort toggle hidden (04-10).
 *
 * The 04-12 markers are an HTML OVERLAY (DOM, introspectable): the load-bearing
 * assertions hit (a) the pure clustering shape via the pixel-merge contract and
 * (b) source checks — the chart ships ChartMarkerOverlay + areaStyle + smooth +
 * the crosshair axis tooltip and NO canvas markPoint; the Steam detail modal
 * ships no chart. (DOM chip positions need a laid-out chart instance, which the
 * jsdom-free browser project gives, but x-pixel layout is timing-sensitive; the
 * structural source checks are the durable, non-flaky assertions.)
 *
 * Component-mount style (mirrors event-detail-dual-render.test.ts): mount the
 * real components into a host div, drive the viewport via page.viewport(), and
 * assert DOM + data-attributes. No auth harness / preview server needed — these
 * are leaf components fed plain props.
 *
 * Run: vitest --project=browser tests/browser/charts-360.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { page } from "@vitest/browser/context";
import WishlistCorrelationChart from "../../src/lib/components/charts/WishlistCorrelationChart.svelte";
import EventDayModal from "../../src/lib/components/charts/EventDayModal.svelte";
import DateRangeRow from "../../src/lib/components/feed/DateRangeRow.svelte";
import {
  eventThumbnail,
  buildDayGroups,
  inRange,
  eventDay,
} from "../../src/lib/components/charts/wishlist-chart-shared.js";
import correlationChartSource from "../../src/lib/components/charts/WishlistCorrelationChart.svelte?raw";
import growthChartSource from "../../src/lib/components/charts/WishlistGrowthChart.svelte?raw";
import overlaySource from "../../src/lib/components/charts/ChartMarkerOverlay.svelte?raw";
import steamModalSource from "../../src/lib/components/SteamListingDetailModal.svelte?raw";
import { m } from "../../src/lib/paraglide/messages.js";

let host: HTMLElement;

// A bare wishlist series (no CSV) → D-08 empty-state branch.
const emptySeries = { points: [], lastImportedAt: null };

// A short series (low-data) → still renders, D-07 consistency. Its wishlist
// points sit on 2026-05-14..15, while baseEvents land on 2026-05-15 — for the
// off-window assertion below we also use a series whose span is BEFORE/AFTER
// the events to prove the union-domain fix.
const shortSeries = {
  points: [
    { date: "2026-05-14", balance: 100 },
    { date: "2026-05-15", balance: 140 },
  ],
  lastImportedAt: "2026-05-15T08:00:00.000Z",
};

// A wishlist series whose dates are AFTER all the events (04-10 regression
// case): events on 2026-05-15, wishlist points on 2026-05-28..30. Pre-fix the
// markers rendered off-canvas; the union x-axis domain keeps them visible.
const offWindowSeries = {
  points: [
    { date: "2026-05-28", balance: 200 },
    { date: "2026-05-29", balance: 240 },
    { date: "2026-05-30", balance: 260 },
  ],
  lastImportedAt: "2026-05-30T08:00:00.000Z",
};

const baseEvents = [
  {
    id: "ev_1",
    gameIds: ["g1"],
    sourceId: "src_1",
    kind: "youtube_video" as const,
    authorIsMe: true,
    occurredAt: new Date("2026-05-15T08:00:00Z"),
    title: "Trailer drop",
    url: "https://example.com/watch",
    notes: null,
    metadata: null,
    externalId: "abc123",
    publishedAt: new Date("2026-05-14T08:00:00Z"),
    lastPolledAt: null,
    lastPollStatus: null,
    createdAt: new Date("2026-05-15T08:00:00Z"),
    updatedAt: new Date("2026-05-15T08:00:00Z"),
    deletedAt: null,
    stats: { viewCount: 1234, likeCount: 56, commentCount: 7, polledAt: new Date() },
    channelTitle: "Test Channel",
  },
  {
    id: "ev_2",
    gameIds: ["g1"],
    sourceId: "src_2",
    kind: "reddit_post" as const,
    authorIsMe: true,
    occurredAt: new Date("2026-05-15T10:00:00Z"),
    title: "Reddit launch thread",
    url: "https://reddit.com/r/test/x",
    notes: null,
    metadata: null,
    externalId: "r1",
    publishedAt: null,
    lastPolledAt: null,
    lastPollStatus: null,
    createdAt: new Date("2026-05-15T10:00:00Z"),
    updatedAt: new Date("2026-05-15T10:00:00Z"),
    deletedAt: null,
    stats: null,
    channelTitle: null,
  },
];

// Per-listing nested delta map: deltaByDate[listingId][YYYY-MM-DD] (04-07
// multi-listing). The chart keys deltas by the listing the line belongs to.
const deltaByDate = {
  l1: {
    "2026-05-15": { delta24h: 47, delta7d: 120, windowFrom: "2026-05-15", windowTo: "2026-05-22" },
  },
};

// One active listing for the single-line case the legacy tests exercise.
const baseListings = [{ id: "l1", name: "Game One", appId: 111 }];

const baseSources = [
  { id: "src_1", displayName: "My Test Channel", handleUrl: "https://youtube.com/@test" },
  { id: "src_2", displayName: "r/test", handleUrl: "https://reddit.com/r/test" },
];

const baseGames = [{ id: "g1", title: "Game One" }];

const TODAY = "2026-05-16T08:00:00.000Z";

function mountChart(series: typeof emptySeries | typeof shortSeries | typeof offWindowSeries): {
  root: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(WishlistCorrelationChart, {
    target: host,
    props: {
      seriesByListing: { l1: series },
      events: baseEvents,
      listings: baseListings,
      today: TODAY,
      // 04-08: range + legend lifted to the page; the chart is controlled.
      // 04-09: visibility driven purely by the `visible` map.
      // 04-12: the chart emits the tapped cluster's day(s) up via
      // onSelectCluster (the page owns the centered EventDayModal); the markers
      // are an HTML overlay (ChartMarkerOverlay), not canvas markPoints.
      range: null,
      visible: {},
      onSelectCluster: vi.fn(),
    },
  });
  flushSync();
  const root = host.querySelector(
    '[data-testid="wishlist-correlation-chart"]',
  ) as HTMLElement | null;
  if (!root) throw new Error("WishlistCorrelationChart root not found");
  return { root, component };
}

function mountDayModal(): { dialog: HTMLDialogElement; component: ReturnType<typeof mount> } {
  const onClose = vi.fn();
  const sourceById = new Map(baseSources.map((s) => [s.id, s]));
  const gameById = new Map(baseGames.map((g) => [g.id, g]));
  const component = mount(EventDayModal, {
    target: host,
    props: {
      open: true,
      // 04-12: the modal takes a SET of days (a cluster); a single-day cluster
      // still shows that day's delta.
      days: ["2026-05-15"],
      events: baseEvents,
      delta: deltaByDate.l1["2026-05-15"],
      sourceById,
      gameById,
      games: baseGames,
      onClose,
    },
  });
  flushSync();
  const dialog = host.querySelector(
    'dialog[data-testid="event-day-modal"]',
  ) as HTMLDialogElement | null;
  if (!dialog) throw new Error("EventDayModal <dialog> not found");
  return { dialog, component };
}

// 04-13: a MULTI-day cluster (e.g. 27 merged with 28). The modal groups the
// events under per-day FeedDateGroupHeaders so both days stay distinct. The two
// baseEvents are on 2026-05-15; add a third on 2026-05-16 to span two days.
const multiDayEvents = [
  ...baseEvents,
  {
    ...baseEvents[0]!,
    id: "ev_3",
    occurredAt: new Date("2026-05-16T09:00:00Z"),
    title: "Follow-up devlog",
    externalId: "xyz789",
  },
];

function mountMultiDayModal(): {
  dialog: HTMLDialogElement;
  component: ReturnType<typeof mount>;
} {
  const onClose = vi.fn();
  const sourceById = new Map(baseSources.map((s) => [s.id, s]));
  const gameById = new Map(baseGames.map((g) => [g.id, g]));
  const component = mount(EventDayModal, {
    target: host,
    props: {
      open: true,
      // Two days in the cluster → the modal groups by day (multi-day branch).
      days: ["2026-05-15", "2026-05-16"],
      events: multiDayEvents,
      // A multi-day cluster carries NO delta (which day's delta?).
      delta: null,
      sourceById,
      gameById,
      games: baseGames,
      onClose,
    },
  });
  flushSync();
  const dialog = host.querySelector(
    'dialog[data-testid="event-day-modal"]',
  ) as HTMLDialogElement | null;
  if (!dialog) throw new Error("EventDayModal <dialog> not found");
  return { dialog, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("charts at 360px (VIZ-04)", () => {
  it("wishlist correlation chart container reflows at 360px and 600px (Plan 04-05 / VIZ-04)", async () => {
    for (const width of [360, 600]) {
      await page.viewport(width, 720);
      const { root, component } = mountChart(emptySeries);
      // The chart wrapper fits within the viewport — it never widens the
      // document past the viewport (no chart-induced horizontal scroll).
      expect(root.scrollWidth).toBeLessThanOrEqual(width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      // markers derive from the events regardless of CSV presence.
      expect(root.getAttribute("data-marker-count")).toBe("1");
      unmount(component);
    }
  });

  it("event markers render even when events fall OUTSIDE the wishlist date span (04-10)", async () => {
    await page.viewport(900, 720);
    // Wishlist points are on 2026-05-28..30; events are on 2026-05-15 (before
    // the wishlist span). Pre-fix the markers rendered off-canvas — the
    // union-domain fix keeps them. We assert the marker is still derived (the
    // x-axis min/max now spans events ∪ points so it lands on-canvas).
    const { root, component } = mountChart(offWindowSeries);
    expect(root.getAttribute("data-marker-count")).toBe("1");
    expect(root.getAttribute("data-low-data")).toBe("false");
    unmount(component);
  });

  it("marker-click surface is a CENTERED EventDayModal with stats + feed cards (04-10)", async () => {
    await page.viewport(900, 720);
    const { dialog, component } = mountDayModal();
    // Centered modal, NOT the old docked drawer/sheet (no data-variant).
    expect(dialog.getAttribute("data-variant")).toBeNull();
    expect(dialog.open).toBe(true);
    // Stats header: the day's delta is shown.
    const stats = dialog.querySelector('[data-testid="day-stats"]');
    expect(stats).not.toBeNull();
    expect(stats?.textContent).toContain(m.viz_delta_7d({ value: "+120" }));
    // The event count surfaces in the header.
    expect(stats?.textContent).toContain(m.viz_day_modal_event_count({ count: 2 }));
    // The day's events render as FeedCard rows (one per event).
    const cards = dialog.querySelectorAll(".event-cards > *");
    expect(cards.length).toBe(baseEvents.length);
    unmount(component);
  });

  it("chart date control is the feed preset picker with sort hidden (04-10)", async () => {
    await page.viewport(900, 720);
    const onDateRangeChange = vi.fn();
    const component = mount(DateRangeRow, {
      target: host,
      props: {
        dateRange: { preset: "all" },
        onDateRangeChange,
        showSort: false,
        today: new Date("2026-05-16T00:00:00"),
      },
    });
    flushSync();
    const row = host.querySelector(".date-range-row") as HTMLElement | null;
    expect(row).not.toBeNull();
    // Preset chips present (All time / Year / Month / Week / Today).
    const presetChips = row!.querySelectorAll(".preset-chips .chip");
    expect(presetChips.length).toBe(5);
    // Sort toggle is hidden on the chart range (showSort=false).
    expect(row!.querySelector(".sort-toggle")).toBeNull();
    unmount(component);
  });

  it("low-data caption renders (Plan 04-05 / D-07)", async () => {
    await page.viewport(360, 720);
    const { root, component } = mountChart(shortSeries);
    expect(root.getAttribute("data-low-data")).toBe("false");
    const caption = root.querySelector(".updated-caption");
    expect(caption).not.toBeNull();
    expect(caption?.textContent?.trim().length).toBeGreaterThan(0);
    unmount(component);
  });

  it("no-CSV empty-state CTA renders (Plan 04-05 / D-08)", async () => {
    await page.viewport(360, 720);
    const { root, component } = mountChart(emptySeries);
    // data-low-data="true" flags the no-CSV branch.
    expect(root.getAttribute("data-low-data")).toBe("true");
    // The empty-state CTA text + the import link both render.
    const cta = root.querySelector(".no-wishlist-cta");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain(m.chart_no_wishlist_cta());
    const link = root.querySelector(".no-wishlist-cta-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/keys/steam");
    // Markers STILL render with no CSV (D-08) — derived from events.
    expect(root.getAttribute("data-marker-count")).toBe("1");
    unmount(component);
  });
});

describe("04-12 HTML marker overlay + area/smooth/crosshair + Steam mini-chart removal", () => {
  it("eventThumbnail derives the YouTube preview from externalId (no enrichment)", () => {
    expect(eventThumbnail(baseEvents[0]!)).toBe("https://img.youtube.com/vi/abc123/mqdefault.jpg");
  });

  it("eventThumbnail uses the Reddit enrichment preview image when image-like", () => {
    const redditWithImage = {
      ...baseEvents[1]!,
      redditEnrichment: { linkUrl: "https://i.redd.it/abc.jpg" },
    };
    expect(eventThumbnail(redditWithImage)).toBe("https://i.redd.it/abc.jpg");
  });

  it("eventThumbnail returns null for a kind with no derivable image (KindIcon path)", () => {
    // No derivable image → the overlay chip renders a <KindIcon> instead of an
    // <img> thumbnail.
    expect(eventThumbnail({ ...baseEvents[1]!, redditEnrichment: null })).toBeNull();
  });

  it("buildDayGroups collapses same-day events into ONE group (the chip's count)", () => {
    // Two events on the SAME day → one DayGroup carrying both → the overlay chip
    // renders a count badge "2".
    const sameDay = [
      baseEvents[0]!,
      { ...baseEvents[1]!, occurredAt: new Date("2026-05-15T11:00:00Z") },
    ];
    const groups = buildDayGroups(sameDay, null);
    expect(groups.length).toBe(1);
    expect(groups[0]!.events.length).toBe(2);
    expect(groups[0]!.mixedKind).toBe(true);
  });

  it("the overlay renders a pixel-positioned chip per cluster + a count badge", async () => {
    await page.viewport(900, 720);
    const { root, component } = mountChart(shortSeries);
    // Give the chart a moment to finish its first render so convertToPixel +
    // the 'finished' handler lay out the chips.
    await new Promise((r) => setTimeout(r, 200));
    flushSync();
    // Two events on the same day (2026-05-15) → ONE cluster chip with a "2"
    // count badge.
    const chips = root.querySelectorAll('[data-testid="chart-marker-chip"]');
    expect(chips.length).toBe(1);
    const badge = root.querySelector('[data-testid="chart-marker-count"]');
    expect(badge?.textContent).toBe("2");
    unmount(component);
  });

  it("the correlation chart ships the HTML overlay, no canvas markPoint (source check)", () => {
    // The canvas markPoint markers are gone — the markers are an HTML overlay
    // (ChartMarkerOverlay) that can pixel-cluster + render borders/icons.
    expect(correlationChartSource).not.toContain("markPoint");
    expect(correlationChartSource).not.toContain("MarkPointComponent");
    expect(correlationChartSource).toContain("ChartMarkerOverlay");
    // No var()/color-mix passed to the ECharts option (the canvas can't resolve
    // them). The overlay (DOM) is allowed CSS tokens — assert only the chart
    // option region (the <script>), not the <style>.
    const script = correlationChartSource.slice(
      correlationChartSource.indexOf("<script"),
      correlationChartSource.indexOf("</script>"),
    );
    expect(script).not.toContain("var(--");
    expect(script).not.toContain("color-mix(");
  });

  it("the overlay clusters by SCREEN distance via convertToPixel (source check)", () => {
    // The pile-up fix: position each day at its x-pixel and MERGE chips within
    // ~44px. These are the load-bearing mechanics.
    expect(overlaySource).toContain("convertToPixel");
    expect(overlaySource).toContain("CLUSTER_PX");
    expect(overlaySource).toContain("KindIcon");
  });

  it("the correlation chart has a filled area + smooth line + crosshair tooltip (source check)", () => {
    expect(correlationChartSource).toContain("areaStyle");
    expect(correlationChartSource).toContain("smooth: true");
    expect(correlationChartSource).toContain("axisPointer");
    expect(correlationChartSource).toContain('trigger: "axis"');
  });

  it("the Steam listing detail modal ships NO wishlist chart (source check)", () => {
    // The mini wishlist chart (which duplicated the page chart with less data)
    // is removed — no svelte-echarts import, no Chart mount, no series prop.
    expect(steamModalSource).not.toContain("svelte-echarts");
    expect(steamModalSource).not.toContain("use([");
    expect(steamModalSource).not.toContain("wishlist-chart");
  });

  it("the cluster modal accepts a SET of days; a single-day cluster shows its delta", async () => {
    await page.viewport(900, 720);
    const { dialog, component } = mountDayModal();
    // Single-day cluster → its day label + the delta block render.
    expect(dialog.textContent).toContain("2026-05-15");
    const stats = dialog.querySelector('[data-testid="day-stats"]');
    expect(stats?.textContent).toContain(m.viz_delta_7d({ value: "+120" }));
    unmount(component);
  });

  it("feed range-sync: inRange + eventDay filter the feed events by the chart window", () => {
    // The page builds the events feed from events.filter(inRange(eventDay(e), window)).
    // Events on 2026-05-15; a May window keeps them, an April window drops them.
    const mayWindow = { from: new Date("2026-05-01"), to: new Date("2026-05-31") };
    const aprWindow = { from: new Date("2026-04-01"), to: new Date("2026-04-30") };
    expect(baseEvents.filter((e) => inRange(eventDay(e), mayWindow)).length).toBe(
      baseEvents.length,
    );
    expect(baseEvents.filter((e) => inRange(eventDay(e), aprWindow)).length).toBe(0);
    // null window (All time) keeps everything.
    expect(baseEvents.filter((e) => inRange(eventDay(e), null)).length).toBe(baseEvents.length);
  });
});

describe("04-13 unified marker language + rich tooltip + per-day modal grouping", () => {
  it("BOTH charts mount the same HTML overlay; neither paints a canvas markLine/markPoint", () => {
    // The unification: the growth chart's old canvas markLine is gone — it now
    // mounts the SAME ChartMarkerOverlay the correlation chart does, so the two
    // charts read identically (dashed line + thumbnail/icon chip).
    for (const src of [correlationChartSource, growthChartSource]) {
      expect(src).toContain("ChartMarkerOverlay");
    }
    // No canvas markers on EITHER chart (the overlay replaced them). Assert on
    // the <script> region only — comments above describe the removal.
    for (const src of [correlationChartSource, growthChartSource]) {
      const script = src.slice(src.indexOf("<script"), src.indexOf("</script>"));
      expect(script).not.toContain("markLine");
      expect(script).not.toContain("markPoint");
      expect(script).not.toContain("buildMarkLineData");
    }
    // The growth chart binds the live ECharts instance for the overlay (the
    // overlay reads it to pixel-position the chips), like the correlation chart.
    expect(growthChartSource).toContain("bind:chart");
  });

  it("the overlay draws a dashed vertical guide line per chip down to the plot bottom (source check)", () => {
    // The shared marker language: a dashed guide line dropping from each chip to
    // the x-axis. Computed from the grid coordinate-system rect (plotBottom).
    expect(overlaySource).toContain("dashed");
    expect(overlaySource).toContain("marker-guide");
    expect(overlaySource).toContain("plotBottom");
  });

  it("the rich tooltip lists each cluster event with thumbnail/KindIcon + title + day", async () => {
    await page.viewport(900, 720);
    const { root, component } = mountChart(shortSeries);
    await new Promise((r) => setTimeout(r, 200));
    flushSync();
    const chip = root.querySelector('[data-testid="chart-marker-chip"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    // Hover → the rich tooltip renders one ROW per event (not just a count).
    chip!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    flushSync();
    const tooltip = root.querySelector('[data-testid="chart-marker-tooltip"]');
    expect(tooltip).not.toBeNull();
    // The two same-day events (Trailer drop + Reddit launch thread) each get a
    // row with their title; the first has a YouTube thumbnail <img>.
    expect(tooltip?.textContent).toContain("Trailer drop");
    expect(tooltip?.textContent).toContain("Reddit launch thread");
    expect(tooltip?.querySelector("img.tt-thumb")).not.toBeNull();
    // Per-event day hint ("May 15") is present.
    expect(tooltip?.textContent).toContain("May 15");
    unmount(component);
  });

  it("a multi-day cluster modal groups events under per-day date headers (27 vs 28 distinct)", async () => {
    await page.viewport(900, 720);
    const { dialog, component } = mountMultiDayModal();
    // Two distinct day headers (one per merged day) so each day is actionable.
    const headers = dialog.querySelectorAll(".event-cards.grouped .date-head");
    expect(headers.length).toBe(2);
    // All three events still render as cards under their respective day headers.
    const cards = dialog.querySelectorAll(".event-cards > :not(.date-head)");
    expect(cards.length).toBe(multiDayEvents.length);
    // A multi-day cluster shows NO delta block (ambiguous which day).
    const stats = dialog.querySelector('[data-testid="day-stats"]');
    expect(stats?.querySelector(".day-delta")).toBeNull();
    unmount(component);
  });

  it("a single-day cluster modal stays a flat list with its delta (unchanged)", async () => {
    await page.viewport(900, 720);
    const { dialog, component } = mountDayModal();
    // No per-day headers in the single-day case.
    expect(dialog.querySelectorAll(".date-head").length).toBe(0);
    // The delta block still renders for the single day.
    const stats = dialog.querySelector('[data-testid="day-stats"]');
    expect(stats?.querySelector(".day-delta")).not.toBeNull();
    unmount(component);
  });
});

describe("04-14 per-day clickable dashed lines + centroid card + identical cross-chart geometry", () => {
  // Two event-days far enough apart (May 1 vs May 30) that, on a wide viewport,
  // their thumbnail CARDS stay separate — so we can assert one dashed line PER
  // event-day. A close pair (May 14 + May 15) lands within CLUSTER_PX and MERGES
  // into one centroid-positioned card while STILL drawing two distinct lines.
  const twoDayEvents = [
    { ...baseEvents[0]!, id: "d1", occurredAt: new Date("2026-05-01T08:00:00Z") },
    {
      ...baseEvents[1]!,
      id: "d2",
      occurredAt: new Date("2026-05-30T10:00:00Z"),
      externalId: "r2",
    },
  ];

  // Four event-days spanning ~30 days (May 1..30) so a one-day gap maps to
  // < CLUSTER_PX (44) px → the ADJACENT pair (May 14 + May 15) merges into one
  // centroid-positioned card while each still draws its own dashed line; the
  // far-apart May 1 and May 30 stay their own cards. → 4 lines, 3 cards.
  const adjacentDayEvents = [
    {
      ...baseEvents[0]!,
      id: "a0",
      occurredAt: new Date("2026-05-01T08:00:00Z"),
      externalId: "a0v",
    },
    {
      ...baseEvents[0]!,
      id: "a1",
      occurredAt: new Date("2026-05-14T08:00:00Z"),
      externalId: "a1v",
    },
    {
      ...baseEvents[0]!,
      id: "a2",
      occurredAt: new Date("2026-05-15T08:00:00Z"),
      externalId: "a2v",
    },
    {
      ...baseEvents[0]!,
      id: "a3",
      occurredAt: new Date("2026-05-30T08:00:00Z"),
      externalId: "a3v",
    },
  ];

  function mountChartWith(
    events: typeof baseEvents,
    series: typeof shortSeries,
  ): {
    root: HTMLElement;
    component: ReturnType<typeof mount>;
    onSelectCluster: ReturnType<typeof vi.fn>;
  } {
    const onSelectCluster = vi.fn();
    const component = mount(WishlistCorrelationChart, {
      target: host,
      props: {
        seriesByListing: { l1: series },
        events,
        listings: baseListings,
        today: TODAY,
        range: null,
        visible: {},
        onSelectCluster,
      },
    });
    flushSync();
    const root = host.querySelector(
      '[data-testid="wishlist-correlation-chart"]',
    ) as HTMLElement | null;
    if (!root) throw new Error("WishlistCorrelationChart root not found");
    return { root, component, onSelectCluster };
  }

  it("draws one dashed guide line per EVENT-DAY (every day with events)", async () => {
    await page.viewport(900, 720);
    const { root, component } = mountChartWith(twoDayEvents, shortSeries);
    await new Promise((r) => setTimeout(r, 250));
    flushSync();
    // Two distinct event-days → two dashed lines (one per day), regardless of
    // how the thumbnail cards cluster.
    const lines = root.querySelectorAll('[data-testid="chart-marker-guide"]');
    expect(lines.length).toBe(2);
    unmount(component);
  });

  it("a per-day line click selects that SINGLE day", async () => {
    await page.viewport(900, 720);
    const { root, component, onSelectCluster } = mountChartWith(twoDayEvents, shortSeries);
    await new Promise((r) => setTimeout(r, 250));
    flushSync();
    const hits = root.querySelectorAll(
      '[data-testid="chart-marker-guide-hit"]',
    ) as NodeListOf<HTMLButtonElement>;
    expect(hits.length).toBe(2);
    hits[0]!.click();
    flushSync();
    // The line emits a single-day array (the merged-away day stays selectable).
    expect(onSelectCluster).toHaveBeenCalledTimes(1);
    const arg = onSelectCluster.mock.calls[0]![0] as string[];
    expect(arg.length).toBe(1);
    unmount(component);
  });

  it("a merged card sits BETWEEN its member days' lines (centroid placement)", async () => {
    await page.viewport(900, 720);
    const { root, component } = mountChartWith(adjacentDayEvents, offWindowSeries);
    await new Promise((r) => setTimeout(r, 250));
    flushSync();
    // Four event-days → four lines; the adjacent May14+15 pair merges → 3 cards.
    const lines = root.querySelectorAll(
      '[data-testid="chart-marker-guide-hit"]',
    ) as NodeListOf<HTMLElement>;
    const chips = root.querySelectorAll(
      '[data-testid="chart-marker-chip"]',
    ) as NodeListOf<HTMLElement>;
    expect(lines.length).toBe(4);
    expect(chips.length).toBe(3);
    const lineX = [...lines]
      .map((el) => el.getBoundingClientRect())
      .map((r) => r.left + r.width / 2)
      .sort((a, b) => a - b);
    const chipX = [...chips]
      .map((el) => el.getBoundingClientRect())
      .map((r) => r.left + r.width / 2)
      .sort((a, b) => a - b);
    // The merged card carries a "2" count badge — find it; its center x must lie
    // BETWEEN its two member lines' center x (the centroid), not on either line.
    const mergedChip = [...chips].find(
      (el) => el.querySelector('[data-testid="chart-marker-count"]')?.textContent === "2",
    );
    expect(mergedChip).toBeDefined();
    const mr = mergedChip!.getBoundingClientRect();
    const mergedX = mr.left + mr.width / 2;
    // The two adjacent lines are the 2nd and 3rd from the left (May 14, May 15).
    expect(mergedX).toBeGreaterThan(lineX[1]! - 1);
    expect(mergedX).toBeLessThan(lineX[2]! + 1);
    // It is strictly the average of the two — within a couple px.
    const midpoint = (lineX[1]! + lineX[2]!) / 2;
    expect(Math.abs(mergedX - midpoint)).toBeLessThan(3);
    void chipX;
    unmount(component);
  });

  it("both charts share the SAME fixed plot geometry (source check) → identical clusters", () => {
    // The cross-chart clustering fix: a fixed, IDENTICAL grid left/right with
    // containLabel:false on BOTH charts so a date maps to the same x-pixel.
    for (const src of [correlationChartSource, growthChartSource]) {
      expect(src).toContain("WISHLIST_CHART_GRID");
    }
  });
});

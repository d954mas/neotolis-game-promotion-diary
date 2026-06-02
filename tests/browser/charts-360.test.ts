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
    expect(eventThumbnail(baseEvents[0]!)).toBe(
      "https://img.youtube.com/vi/abc123/mqdefault.jpg",
    );
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

/**
 * VIZ-04 — chart reflow + responsive detail surface under 600px (Plan 04-05).
 *
 * ECharts paints to canvas (not DOM-introspectable), so these assert the
 * WRAPPER / structure + data-attributes, not chart internals:
 *   - the WishlistCorrelationChart container reflows (fits its column, no
 *     horizontal overflow) at 360px AND 600px viewport widths — VIZ-04 / D-10;
 *   - the EventMarkerPanel docks BOTTOM (sheet) <600px and RIGHT (drawer)
 *     >=600px via its data-variant attribute — D-02;
 *   - the no-CSV empty-state CTA renders while markers still render — D-08;
 *   - the chart still renders with a short (low-data) series — D-07 consistency.
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
import EventMarkerPanel from "../../src/lib/components/charts/EventMarkerPanel.svelte";
import { m } from "../../src/lib/paraglide/messages.js";

let host: HTMLElement;

// A bare wishlist series (no CSV) → D-08 empty-state branch.
const emptySeries = { points: [], lastImportedAt: null };

// A short series (low-data) → still renders, D-07 consistency.
const shortSeries = {
  points: [
    { date: "2026-05-14", balance: 100 },
    { date: "2026-05-15", balance: 140 },
  ],
  lastImportedAt: "2026-05-15T08:00:00.000Z",
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

const baseGames = [
  {
    id: "g1",
    title: "Game One",
    coverUrl: null,
    releaseDate: null,
    releaseTba: false,
    tags: [],
    notes: "",
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  },
];

const baseSources = [
  {
    id: "src_1",
    kind: "youtube_channel" as const,
    handleUrl: "https://youtube.com/@test",
    channelId: "UCxxx",
    displayName: "My Test Channel",
    note: null,
    isOwnedByMe: true,
    autoImport: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    channelTitle: "Test Channel",
    needsReconnect: false,
    lastErrorAt: null,
    lastErrorKind: null,
    lastPolledAt: null,
    backfillOldestAt: null,
    backfillComplete: false,
    backfillTargetSince: null,
  },
];

const TODAY = "2026-05-16T08:00:00.000Z";

function mountChart(series: typeof emptySeries | typeof shortSeries): {
  root: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(WishlistCorrelationChart, {
    target: host,
    props: {
      seriesByListing: { l1: series },
      events: baseEvents,
      deltaByDate,
      listings: baseListings,
      sources: baseSources,
      games: baseGames,
      today: TODAY,
    },
  });
  flushSync();
  const root = host.querySelector(
    '[data-testid="wishlist-correlation-chart"]',
  ) as HTMLElement | null;
  if (!root) throw new Error("WishlistCorrelationChart root not found");
  return { root, component };
}

function mountPanel(): { dialog: HTMLDialogElement; component: ReturnType<typeof mount> } {
  const onClose = vi.fn();
  const component = mount(EventMarkerPanel, {
    target: host,
    props: {
      dayEvents: baseEvents,
      delta: deltaByDate.l1["2026-05-15"],
      sources: baseSources,
      games: baseGames,
      onClose,
    },
  });
  flushSync();
  const dialog = host.querySelector(
    'dialog[data-testid="event-marker-panel"]',
  ) as HTMLDialogElement | null;
  if (!dialog) throw new Error("EventMarkerPanel <dialog> not found");
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

  it("marker detail surface opens as bottom-sheet <600px and drawer >=600px (Plan 04-05 / D-02)", async () => {
    // >=600px → drawer.
    await page.viewport(900, 720);
    const drawer = mountPanel();
    expect(drawer.dialog.getAttribute("data-variant")).toBe("drawer");
    unmount(drawer.component);

    // <600px → bottom sheet.
    await page.viewport(360, 720);
    const sheet = mountPanel();
    expect(sheet.dialog.getAttribute("data-variant")).toBe("sheet");
    unmount(sheet.component);
  });

  it("low-data dots+caption render (Plan 04-05 / D-07)", async () => {
    await page.viewport(360, 720);
    const { root, component } = mountChart(shortSeries);
    // A short (2-point) series still renders the chart frame + the honest
    // caption (data-low-data="false" since CSV exists; the D-07 dots branch
    // lives in EventHistoryChart — here the correlation chart renders the
    // short series rather than failing).
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
    // The D-08 empty-state copy is the m.chart_no_wishlist_cta message.
    expect(cta?.textContent).toContain(m.chart_no_wishlist_cta());
    const link = root.querySelector(".no-wishlist-cta-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/keys/steam");
    // Markers STILL render with no CSV (D-08) — derived from events.
    expect(root.getAttribute("data-marker-count")).toBe("1");
    unmount(component);
  });
});

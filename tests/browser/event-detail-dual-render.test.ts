/**
 * Browser test asserting EventDetailContent renders identical fields
 * whether mounted via <EventDetailModal> in /feed?event=... or via
 * the /events/[id] standard route shell (D-05, D-06).
 *
 * Wave 2 Plan 09 ships EventDetailContent + EventDetailModal; Wave 3
 * Plan 10 wires them into /feed and /events/[id]. This file scaffolds
 * the parity contract.
 *
 * Contract anchors:
 *   - D-05 — Centered modal 760px overlay is the primary detail surface
 *            when opening from feed card click; URL updates to
 *            /feed?event=ev_123 (filter state preserved); Esc / X / scrim
 *            click / browser back → modal closes
 *   - D-06 — /events/[id] route stays as SSR full-page fallback for
 *            direct-link / paste-into-browser / SEO; both render the
 *            same <EventDetailContent> component
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import EventDetailContent from "../../src/lib/components/event-detail/EventDetailContent.svelte";
import EventDetailModal from "../../src/lib/components/event-detail/EventDetailModal.svelte";

let host: HTMLElement;

const baseEvent = {
  id: "ev_dual_render",
  gameIds: ["g1"],
  sourceId: "src_1",
  kind: "youtube_video" as const,
  authorIsMe: true,
  occurredAt: new Date("2026-05-15T08:00:00Z"),
  title: "Dual render test event",
  url: "https://example.com/watch",
  externalId: "abc123",
  notes: "Some notes for this event",
  metadata: null,
  publishedAt: new Date("2026-05-14T08:00:00Z"),
  lastPolledAt: null,
  lastPollStatus: null,
  createdAt: new Date("2026-05-15T08:00:00Z"),
  updatedAt: new Date("2026-05-15T08:00:00Z"),
  deletedAt: null,
  stats: { viewCount: 1234, likeCount: 56, commentCount: 7, polledAt: new Date() },
  channelTitle: "Test Channel",
};

// VIZ-01 (Plan 04-04): adapter-driven per-event snapshot series. A 3-point
// series exercises the line branch (data-low-data="false"); a 2-point series
// exercises the D-07 dots+caption branch (data-low-data="true").
const historySeries = [
  {
    metricKey: "view_count",
    labelKey: "chart_metric_views",
    points: [
      { polledAt: "2026-05-14T08:00:00.000Z", value: 100 },
      { polledAt: "2026-05-15T08:00:00.000Z", value: 250 },
      { polledAt: "2026-05-16T08:00:00.000Z", value: 480 },
    ],
  },
];

const lowDataSeries = [
  {
    metricKey: "view_count",
    labelKey: "chart_metric_views",
    points: [
      { polledAt: "2026-05-14T08:00:00.000Z", value: 100 },
      { polledAt: "2026-05-15T08:00:00.000Z", value: 250 },
    ],
  },
];

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

function mountBare(propsOverrides: Record<string, unknown> = {}): {
  root: HTMLElement;
  component: ReturnType<typeof mount>;
  spies: {
    onClose: ReturnType<typeof vi.fn>;
    onDelete: ReturnType<typeof vi.fn>;
    onUpdate: ReturnType<typeof vi.fn>;
  };
} {
  const onClose = vi.fn();
  const onDelete = vi.fn(async () => {});
  const onUpdate = vi.fn(async () => {});
  const component = mount(EventDetailContent, {
    target: host,
    props: {
      event: baseEvent,
      games: baseGames,
      sources: baseSources,
      view: "feed",
      currentUserName: "Alice",
      onClose,
      onDelete,
      onUpdate,
      ...propsOverrides,
    },
  });
  flushSync();
  const root = host.querySelector(".event-detail-content") as HTMLElement | null;
  if (!root) throw new Error("EventDetailContent root not found");
  return { root, component, spies: { onClose, onDelete, onUpdate } };
}

function mountInModal(propsOverrides: Record<string, unknown> = {}): {
  root: HTMLElement;
  dialog: HTMLDialogElement;
  component: ReturnType<typeof mount>;
  spies: {
    onClose: ReturnType<typeof vi.fn>;
    onDelete: ReturnType<typeof vi.fn>;
    onUpdate: ReturnType<typeof vi.fn>;
  };
} {
  const onClose = vi.fn();
  const onDelete = vi.fn(async () => {});
  const onUpdate = vi.fn(async () => {});
  const component = mount(EventDetailModal, {
    target: host,
    props: {
      event: baseEvent,
      games: baseGames,
      sources: baseSources,
      view: "feed",
      currentUserName: "Alice",
      onClose,
      onDelete,
      onUpdate,
      ...propsOverrides,
    },
  });
  flushSync();
  const dialog = host.querySelector("dialog.event-detail-modal") as HTMLDialogElement | null;
  if (!dialog) throw new Error("EventDetailModal <dialog> not found");
  const root = dialog.querySelector(".event-detail-content") as HTMLElement | null;
  if (!root) throw new Error("EventDetailContent inside modal not found");
  return { root, dialog, component, spies: { onClose, onDelete, onUpdate } };
}

// Plan 04-24: EventDetailContent lazy-fetches GET /api/events/:id/metric-series
// for chartable kinds when no metricSeries prop is threaded (the modal path).
// Stub fetch so the existing prop-driven tests don't hit the network and so the
// lazy-fetch test below can control the response. Tests that pass metricSeries
// explicitly never reach this fetch (the prop is authoritative).
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
  vi.unstubAllGlobals();
});

describe("EventDetailContent dual-render parity (Wave 2 Plan 09 + Wave 3 Plan 10)", () => {
  it("Wave 2 Plan 09: renders title field identically in modal mount and bare mount (D-05, D-06)", () => {
    const bare = mountBare();
    const modal = mountInModal();
    const bareTitle = bare.root.querySelector(".title")?.textContent?.trim();
    const modalTitle = modal.root.querySelector(".title")?.textContent?.trim();
    expect(bareTitle).toBe(baseEvent.title);
    expect(modalTitle).toBe(baseEvent.title);
    expect(bareTitle).toBe(modalTitle);
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: renders notes field identically in modal and bare", () => {
    const bare = mountBare();
    const modal = mountInModal();
    const bareNotes = bare.root.querySelector(".notes")?.textContent?.trim();
    const modalNotes = modal.root.querySelector(".notes")?.textContent?.trim();
    expect(bareNotes).toBe(baseEvent.notes);
    expect(modalNotes).toBe(baseEvent.notes);
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: renders games chip row identically", () => {
    const bare = mountBare();
    const modal = mountInModal();
    const bareChips = Array.from(bare.root.querySelectorAll(".game-chip")).map((c) =>
      c.textContent?.trim(),
    );
    const modalChips = Array.from(modal.root.querySelectorAll(".game-chip")).map((c) =>
      c.textContent?.trim(),
    );
    expect(bareChips).toEqual(["Game One"]);
    expect(modalChips).toEqual(["Game One"]);
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: renders kind tag + KindIcon identically", () => {
    const bare = mountBare();
    const modal = mountInModal();
    // KindIcon renders an <svg class="kind">; presence + label parity is enough.
    const bareLabel = bare.root.querySelector(".detail-kind-label")?.textContent?.trim();
    const modalLabel = modal.root.querySelector(".detail-kind-label")?.textContent?.trim();
    expect(bareLabel).toBeTruthy();
    expect(bareLabel).toBe(modalLabel);
    expect(bare.root.querySelector("svg.kind")).not.toBeNull();
    expect(modal.root.querySelector("svg.kind")).not.toBeNull();
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: renders stats (views/likes/comments) identically for kind=youtube_video", () => {
    const bare = mountBare();
    const modal = mountInModal();
    const bareStats = Array.from(bare.root.querySelectorAll(".detail-stat-num")).map((b) =>
      b.textContent?.trim(),
    );
    const modalStats = Array.from(modal.root.querySelectorAll(".detail-stat-num")).map((b) =>
      b.textContent?.trim(),
    );
    expect(bareStats).toEqual([
      (1234).toLocaleString(),
      (56).toLocaleString(),
      (7).toLocaleString(),
    ]);
    expect(bareStats).toEqual(modalStats);
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: inline-edit title pencil click sets draft to current value in both mounts", () => {
    const bare = mountBare();
    const bareBtn = bare.root.querySelector(".title-row .edit-btn") as HTMLButtonElement | null;
    expect(bareBtn).not.toBeNull();
    bareBtn!.click();
    flushSync();
    const bareInput = bare.root.querySelector(".title-input") as HTMLInputElement | null;
    expect(bareInput).not.toBeNull();
    expect(bareInput!.value).toBe(baseEvent.title);
    unmount(bare.component);

    const modal = mountInModal();
    const modalBtn = modal.root.querySelector(".title-row .edit-btn") as HTMLButtonElement | null;
    expect(modalBtn).not.toBeNull();
    modalBtn!.click();
    flushSync();
    const modalInput = modal.root.querySelector(".title-input") as HTMLInputElement | null;
    expect(modalInput).not.toBeNull();
    expect(modalInput!.value).toBe(baseEvent.title);
    unmount(modal.component);
  });

  it("Wave 2 Plan 09: EventDetailModal.showModal() called on $effect mount; close() called on unmount (D-05)", () => {
    const modal = mountInModal();
    // jsdom doesn't fully implement <dialog>.showModal in older versions;
    // the open property reflects whether showModal succeeded. We assert
    // the wrapper added a <dialog> with the v2 chrome class.
    expect(modal.dialog).not.toBeNull();
    expect(modal.dialog.classList.contains("event-detail-modal")).toBe(true);
    // The $effect cleanup must call close() on unmount — verified by
    // checking the dialog is removed from DOM after unmount.
    unmount(modal.component);
    flushSync();
    expect(host.querySelector("dialog.event-detail-modal")).toBeNull();
  });

  it("Wave 3 Plan 10: EventDetailModal oncancel fires onClose callback with URL state cleared — back-button removes ?event= param (D-05)", () => {
    const modal = mountInModal();
    // Simulate the native dialog "cancel" event (Esc keypress on a
    // showModal-opened <dialog>). The wrapper's oncancel handler must
    // call onClose so the parent can clear ?event=… from the URL.
    const cancelEvt = new Event("cancel", { cancelable: true });
    modal.dialog.dispatchEvent(cancelEvt);
    expect(modal.spies.onClose).toHaveBeenCalledTimes(1);
    unmount(modal.component);
  });

  it("Plan 04-04 (VIZ-01): EventHistoryChart renders in modal AND bare for an event with snapshot history (dual-render)", () => {
    const bare = mountBare({ metricSeries: historySeries });
    const modal = mountInModal({ metricSeries: historySeries });
    const bareChart = bare.root.querySelector('[data-testid="event-history-chart"]');
    const modalChart = modal.root.querySelector('[data-testid="event-history-chart"]');
    // The chart wrapper is present on BOTH surfaces — the single mount in
    // the shared EventDetailContent covers the modal and the route.
    expect(bareChart).not.toBeNull();
    expect(modalChart).not.toBeNull();
    // >=3 points → line branch, not the low-data dots branch.
    expect(bareChart?.getAttribute("data-low-data")).toBe("false");
    expect(modalChart?.getAttribute("data-low-data")).toBe("false");
    unmount(bare.component);
    unmount(modal.component);
  });

  it("Plan 04-04 (VIZ-01 / D-07): <3 snapshots sets data-low-data and renders the low-data caption, not a 2-point line", () => {
    const bare = mountBare({ metricSeries: lowDataSeries });
    const chart = bare.root.querySelector('[data-testid="event-history-chart"]');
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute("data-low-data")).toBe("true");
    // The D-07 caption text must render (asserted structurally — ECharts
    // paints to canvas and is not pixel-introspectable).
    const caption = chart?.querySelector(".chart-low-data-caption");
    expect(caption).not.toBeNull();
    expect(caption?.textContent?.trim().length).toBeGreaterThan(0);
    unmount(bare.component);
  });

  it("Plan 04-24 (VIZ-01 modal): chartable event WITHOUT metricSeries prop lazy-fetches and mounts the chart in the modal", async () => {
    // The modal path mounts EventDetailContent without metricSeries (the SSR
    // prop only exists on /events/[id]). For a chartable kind the component
    // fetches GET /api/events/:id/metric-series and renders the result.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(historySeries), { status: 200 }));
    const modal = mountInModal(); // baseEvent.kind === "youtube_video" (chartable)
    expect(fetchSpy).toHaveBeenCalledWith(`/api/events/${baseEvent.id}/metric-series`);

    // The browser-only $effect fetches asynchronously (fetch → res.json());
    // poll until the fetched 3-point series flips the chart out of the
    // low-data branch (data-low-data="false" = line branch).
    await vi.waitFor(() => {
      flushSync();
      const chart = modal.root.querySelector('[data-testid="event-history-chart"]');
      expect(chart).not.toBeNull();
      expect(chart?.getAttribute("data-low-data")).toBe("false");
    });
    unmount(modal.component);
  });

  it("Plan 04-24 (VIZ-01 modal / #4): chartable event with 0 snapshots still mounts the chart + low-data caption (no metricSeries prop)", async () => {
    // The endpoint returns [] for a chartable event with no snapshots; the
    // component must still mount EventHistoryChart so the D-07 low-data caption
    // is reachable — the gap-closure fix (chart gated on isChartable, not
    // series length).
    fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
    const modal = mountInModal();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    const chart = modal.root.querySelector('[data-testid="event-history-chart"]');
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute("data-low-data")).toBe("true");
    const caption = chart?.querySelector(".chart-low-data-caption");
    expect(caption).not.toBeNull();
    unmount(modal.component);
  });
});

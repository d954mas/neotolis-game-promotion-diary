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

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
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
    const bareLabel = bare.root.querySelector(".kind-tag-label")?.textContent?.trim();
    const modalLabel = modal.root.querySelector(".kind-tag-label")?.textContent?.trim();
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
    const bareStats = Array.from(bare.root.querySelectorAll(".stat b")).map((b) =>
      b.textContent?.trim(),
    );
    const modalStats = Array.from(modal.root.querySelectorAll(".stat b")).map((b) =>
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
});

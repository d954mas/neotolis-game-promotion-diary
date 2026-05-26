// feedUiStore unit tests — Wave 0 Plan 03 (Foundation C).
//
// Contract per .planning/phases/03.4-design-v2-ux/03.4-CONTEXT.md
// D-03 / D-04 and §"URL State Architecture" in 03.4-RESEARCH.md:
//
//   - feedUiStore is a writable<{ selectedIds, filtersOpen, eventDetailOpen }>.
//     selectedIds is a Set<string>, filtersOpen and eventDetailOpen are bool.
//   - Helpers: toggleSelect(id, force?), clearSelection(), setFiltersOpen(b).
//   - NO localStorage persistence — F5 resets selection by design. The
//     prototype's `v2-filters-open` / `v2-sort-dir` keys were intentionally
//     dropped; URL is the single source of truth for filter state.
//
// Subscriber-fires invariant: every helper must REPLACE the Set instance
// (`new Set(s.selectedIds)`) rather than mutating in place — Svelte's
// `writable` only re-runs subscribers when the wrapped value is reassigned,
// and mutating a Set in place keeps the reference identical.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  feedUiStore,
  toggleSelect,
  clearSelection,
  setFiltersOpen,
} from "../../src/lib/stores/feed-ui";

beforeEach(() => {
  // Reset between tests — the store is module-level singleton, so without
  // a reset prior tests' state leaks into the next assertion.
  feedUiStore.set({
    selectedIds: new Set(),
    filtersOpen: false,
    eventDetailOpen: false,
  });
});

describe("feedUiStore — initial state", () => {
  it("starts with empty Set, filtersOpen=false, eventDetailOpen=false", () => {
    const s = get(feedUiStore);
    expect(s.selectedIds).toBeInstanceOf(Set);
    expect(s.selectedIds.size).toBe(0);
    expect(s.filtersOpen).toBe(false);
    expect(s.eventDetailOpen).toBe(false);
  });
});

describe("feedUiStore — toggleSelect", () => {
  it("toggleSelect(id) adds the id when absent", () => {
    toggleSelect("ev_1");
    expect(get(feedUiStore).selectedIds.has("ev_1")).toBe(true);
  });

  it("toggleSelect(id) removes the id when present (second call)", () => {
    toggleSelect("ev_1");
    toggleSelect("ev_1");
    expect(get(feedUiStore).selectedIds.has("ev_1")).toBe(false);
  });

  it("toggleSelect(id, true) idempotently adds (no-op if already present)", () => {
    toggleSelect("ev_1", true);
    toggleSelect("ev_1", true);
    const s = get(feedUiStore);
    expect(s.selectedIds.has("ev_1")).toBe(true);
    expect(s.selectedIds.size).toBe(1);
  });

  it("toggleSelect(id, false) idempotently removes (no-op if absent)", () => {
    // absent → still absent
    toggleSelect("ev_missing", false);
    expect(get(feedUiStore).selectedIds.has("ev_missing")).toBe(false);
    // present → removed
    toggleSelect("ev_1", true);
    toggleSelect("ev_1", false);
    expect(get(feedUiStore).selectedIds.has("ev_1")).toBe(false);
  });
});

describe("feedUiStore — clearSelection", () => {
  it("clearSelection() empties the Set", () => {
    toggleSelect("a");
    toggleSelect("b");
    toggleSelect("c");
    expect(get(feedUiStore).selectedIds.size).toBe(3);
    clearSelection();
    expect(get(feedUiStore).selectedIds.size).toBe(0);
  });
});

describe("feedUiStore — setFiltersOpen", () => {
  it("setFiltersOpen(true) sets filtersOpen to true", () => {
    setFiltersOpen(true);
    expect(get(feedUiStore).filtersOpen).toBe(true);
  });

  it("setFiltersOpen(false) sets filtersOpen back to false", () => {
    setFiltersOpen(true);
    setFiltersOpen(false);
    expect(get(feedUiStore).filtersOpen).toBe(false);
  });
});

describe("feedUiStore — eventDetailOpen", () => {
  it("exposes eventDetailOpen toggle via direct update", () => {
    feedUiStore.update((s) => ({ ...s, eventDetailOpen: true }));
    expect(get(feedUiStore).eventDetailOpen).toBe(true);
    feedUiStore.update((s) => ({ ...s, eventDetailOpen: false }));
    expect(get(feedUiStore).eventDetailOpen).toBe(false);
  });
});

describe("feedUiStore — subscriber fires (immutable Set replacement)", () => {
  it("toggleSelect fires subscribers (Set is REPLACED, not mutated)", () => {
    let fires = 0;
    const unsub = feedUiStore.subscribe(() => {
      fires += 1;
    });
    // Subscribe immediately fires once with current state — discount it.
    const base = fires;
    toggleSelect("ev_1");
    toggleSelect("ev_2");
    toggleSelect("ev_1"); // remove
    unsub();
    expect(fires - base).toBe(3);
  });
});

describe("feedUiStore — NO localStorage leakage (D-03 / D-04)", () => {
  it("toggleSelect + setFiltersOpen never call localStorage.setItem", () => {
    // localStorage is defined in jsdom/happy-dom, but the store runs in
    // a node environment for unit tests. Provide a stub globalThis
    // localStorage if absent so the spy has something to spy on.
    if (typeof globalThis.localStorage === "undefined") {
      const stub: Storage = {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {},
      };
      // Cast through unknown — the global is declared on Window in lib.dom
      // but globalThis is typed as a node global object here.
      (globalThis as unknown as { localStorage: Storage }).localStorage = stub;
    }
    const spy = vi.spyOn(globalThis.localStorage, "setItem");
    toggleSelect("ev_1");
    toggleSelect("ev_2");
    setFiltersOpen(true);
    clearSelection();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

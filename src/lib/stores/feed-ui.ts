// Feed UI session-state store — Wave 0 Plan 03 (design-v2 UX).
//
// Holds the in-memory UI state for /feed that does NOT belong in the URL:
//   - selectedIds: which event cards the user has checked for bulk ops
//   - filtersOpen: whether the per-axis filter strip is expanded
//   - eventDetailOpen: whether the EventDetailModal is mounted
//
// Per CONTEXT D-03 / D-04: this store is INTENTIONALLY ephemeral across
// reloads — F5 resets everything because the module re-evaluates. There is
// NO localStorage persistence. The prototype's `v2-filters-open` and
// `v2-sort-dir` keys were dropped — URL params are the single source of
// truth for filter axes that need to survive a reload.
//
// NOTE: the writable singleton survives client-side navigation away from
// /feed and back (the module stays loaded). Selection and filtersOpen are
// preserved on cross-route navigation by design — return-to-feed keeps the
// user's working context. Hard reload (F5) is the only reset path. If a
// future requirement needs unmount-reset, add `onDestroy(clearAll)` in
// `/feed/+page.svelte` — not here, because the store has no lifecycle hook.
//
// The Set<string> in selectedIds is REPLACED on every helper invocation
// (`new Set(s.selectedIds)`); Svelte's `writable` only fires subscribers on
// assignment, not on in-place mutation of a wrapped Set/Map/Array.

import { writable } from "svelte/store";

export interface FeedUiState {
  selectedIds: Set<string>;
  filtersOpen: boolean;
  eventDetailOpen: boolean;
}

const initial: FeedUiState = {
  selectedIds: new Set(),
  filtersOpen: false,
  eventDetailOpen: false,
};

export const feedUiStore = writable<FeedUiState>(initial);

// toggleSelect(id) — flip presence of id in selectedIds.
// toggleSelect(id, true) — idempotently add.
// toggleSelect(id, false) — idempotently remove (no-op if absent).
//
// The `force` param mirrors classList.toggle's optional second argument so
// callers that already know the target state can express it directly
// without computing the current membership themselves.
export function toggleSelect(id: string, force?: boolean): void {
  feedUiStore.update((s) => {
    const next = new Set(s.selectedIds);
    if (force === true || (force === undefined && !next.has(id))) next.add(id);
    else next.delete(id);
    return { ...s, selectedIds: next };
  });
}

export function clearSelection(): void {
  feedUiStore.update((s) => ({ ...s, selectedIds: new Set() }));
}

export function setFiltersOpen(open: boolean): void {
  feedUiStore.update((s) => ({ ...s, filtersOpen: open }));
}

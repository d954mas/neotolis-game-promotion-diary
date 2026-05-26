// feed-state — Svelte 5 state factories for /feed page orchestrator.
//
// Pure functions + reactive state factories that encapsulate feed-level
// client-side state. Each factory returns a reactive object suitable for
// destructuring in the page component. Extracted from +page.svelte to
// reduce the orchestrator to imports + glue + template.
//
// NOT in this file:
//   - URL state (already in url-state.ts)
//   - Filter/facet logic (already in filter-math.ts)
//   - Selection state (already in $lib/stores/feed-ui.ts)

/**
 * createFeedToast — ephemeral toast notification state.
 *
 * Returns a reactive object with:
 *   - current: the active toast (or null)
 *   - show(kind, text): display a new toast
 *   - dismiss(): clear the current toast
 */
export function createFeedToast() {
  let current = $state<{ kind: "success" | "info" | "danger"; text: string } | null>(null);

  return {
    get current() {
      return current;
    },
    show(kind: "success" | "info" | "danger", text: string) {
      current = { kind, text };
    },
    dismiss() {
      current = null;
    },
  };
}

/**
 * createFeedNavOverlay — navigation-in-progress visual overlay state.
 *
 * Gates the visual feedback on BOTH `navigating.to` AND a self-clearing
 * 10s timeout so the overlay can't outlive a real network round-trip by
 * more than a generous bound (well past p99 loader latency). Without the
 * timeout, a dead vite-client websocket (long-idle tab returning to
 * foreground) would leave the overlay stuck forever.
 *
 * The caller must wire the returned `track(navigatingTo)` into a $effect
 * that passes the current `navigating.to` value.
 */
export function createFeedNavOverlay() {
  let active = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function track(navigatingTo: unknown): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (navigatingTo) {
      active = true;
      timer = setTimeout(() => {
        active = false;
        timer = null;
      }, 10_000);
    } else {
      active = false;
    }
  }

  return {
    get active() {
      return active;
    },
    track,
  };
}

/**
 * createGamesPickerState — GamesPicker modal state for both bulk and
 * single-event edit paths.
 *
 * Encapsulates the mode ("bulk" | "single"), target event IDs, and
 * open/close state so the page orchestrator doesn't manage four
 * separate $state values.
 */
export function createGamesPickerState() {
  let open = $state(false);
  let mode = $state<"single" | "bulk">("bulk");
  let targetIds = $state<string[]>([]);

  return {
    get open() {
      return open;
    },
    get mode() {
      return mode;
    },
    get targetIds() {
      return targetIds;
    },
    openForBulk(selectedIds: Set<string>) {
      mode = "bulk";
      targetIds = [...selectedIds];
      open = true;
    },
    openForCard(id: string) {
      mode = "single";
      targetIds = [id];
      open = true;
    },
    close() {
      open = false;
    },
  };
}

/**
 * createInfiniteScroll — cursor-based infinite scroll state.
 *
 * Owns allRows, nextCursor, loading, endReached, and the
 * IntersectionObserver lifecycle. The caller provides the initial data
 * and a fetch function for loading more rows.
 *
 * Returns a reactive object with the current state + a reset() method
 * that the caller invokes when data changes (filter change triggers
 * loader rerun → fresh first page).
 */
export function createInfiniteScroll<T extends { id: string }>(
  initialRows: T[],
  initialCursor: string | null,
) {
  let allRows = $state(initialRows);
  let nextCursor = $state<string | null>(initialCursor);
  let loading = $state(false);
  let endReached = $state(initialCursor === null);

  function reset(rows: T[], cursor: string | null): void {
    allRows = rows;
    nextCursor = cursor;
    endReached = cursor === null;
    loading = false;
  }

  return {
    get allRows() {
      return allRows;
    },
    set allRows(v: T[]) {
      allRows = v;
    },
    get nextCursor() {
      return nextCursor;
    },
    get loading() {
      return loading;
    },
    get endReached() {
      return endReached;
    },
    reset,
    /** Call from the IntersectionObserver callback or a "load more" button. */
    async loadMore(fetchPage: () => Promise<{ rows: T[]; nextCursor: string | null } | null>) {
      if (loading || endReached || !nextCursor) return;
      loading = true;
      try {
        const result = await fetchPage();
        if (!result) {
          endReached = true;
          return;
        }
        allRows = [...allRows, ...result.rows];
        nextCursor = result.nextCursor;
        if (result.nextCursor === null) endReached = true;
      } catch {
        endReached = true;
      } finally {
        loading = false;
      }
    },
  };
}

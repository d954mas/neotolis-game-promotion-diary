<script lang="ts">
  // PageHead — Wave 2a 3-floor chrome for /feed (Plan 03.4-07 Task 2).
  //
  // The new v2 page header is taller than the v1 single-floor PageHeader
  // because /feed gained mass-select + custom date range + always-visible
  // search. The three floors:
  //
  //   1. DISPLAY    title + primary CTA (Add Event) + trash-view badge
  //   2. DATE       DateRangeRow (custom range chip + 5 presets + sort)
  //   3. UTILITY    search input + Filters toggle button (with count)
  //
  // Floor 2 is passed as `children` from the caller (so the orchestrator
  // can choose whether to render DateRangeRow alone or add AxisRow rows
  // when filters are expanded). The PageHead component itself owns floors
  // 1 and 3.
  //
  // LB-3 contract preserved: a ResizeObserver on the rendered <section>
  // publishes the measured height to `--page-header-height` on
  // documentElement. <FeedDateGroupHeader> reads
  //   top: calc(--chrome-height + --page-header-height - --sticky-overlap)
  // so the sticky date headings sit exactly under the chrome+PageHead
  // stack. The raw fractional getBoundingClientRect().height handles
  // subpixel correctness; cleanup sets the variable to "0px" so routes
  // without a PageHead (login, public landing) don't carry stale offsets.
  //
  // Sticky positioning is inherited from the v1 pattern — the consumer
  // (`/feed/+page.svelte`) wraps PageHead in the sticky section, the
  // `sticky` prop is opt-in so non-feed surfaces can render it as a
  // normal block element.

  import { m } from "$lib/paraglide/messages.js";

  let {
    title,
    view,
    onAddEvent,
    query,
    onQueryChange,
    onToggleFilters,
    filtersOpen,
    activeFilterCount,
    sticky = false,
    children,
  }: {
    title: string;
    view: "feed" | "trash";
    onAddEvent: () => void;
    query: string;
    onQueryChange: (q: string) => void;
    onToggleFilters: () => void;
    filtersOpen: boolean;
    activeFilterCount: number;
    sticky?: boolean;
    children?: import("svelte").Snippet;
  } = $props();

  let el: HTMLElement | undefined = $state();

  $effect(() => {
    if (typeof window === "undefined") return;
    if (!el) return;
    const root = document.documentElement;
    const sync = (): void => {
      root.style.setProperty(
        "--page-header-height",
        `${el!.getBoundingClientRect().height}px`,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--page-header-height", "0px");
    };
  });
</script>

<section class="page-head" class:sticky bind:this={el}>
  <!-- Floor 1: display row (title + primary CTA) -->
  <div class="floor display">
    <h1>{title}</h1>
    {#if view === "feed"}
      <button type="button" class="cta-primary" onclick={onAddEvent}>
        + {m.add_event_modal_title()}
      </button>
    {/if}
  </div>

  <!-- Floor 2: date range row (rendered by caller) -->
  {@render children?.()}

  <!-- Floor 3: utility row (search + Filters toggle) -->
  <div class="floor utility">
    <input
      type="search"
      class="search"
      placeholder={view === "trash"
        ? m.feed_search_placeholder_trash()
        : m.feed_search_placeholder()}
      value={query}
      oninput={(e) => onQueryChange(e.currentTarget.value)}
    />
    <button
      type="button"
      class="filters-toggle"
      data-active={filtersOpen ? "1" : "0"}
      onclick={onToggleFilters}
    >
      {m.feed_filters_toggle_label()}
      {#if activeFilterCount > 0}
        <span class="count">{activeFilterCount}</span>
      {/if}
    </button>
  </div>
</section>

<style>
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    background: var(--bg);
    min-width: 0;
  }
  /* Sticky variant — anchors under the global chrome (AppHeader + Nav)
   * single sticky wrapper. The page-head height publishes via
   * ResizeObserver so FeedDateGroupHeader's
   *   top: calc(--chrome-height + --page-header-height - --sticky-overlap)
   * lands directly under the chrome+PageHead stack (LB-3). */
  .page-head.sticky {
    position: sticky;
    top: calc(var(--chrome-height, 116px) - var(--sticky-overlap, 1px));
    z-index: 5;
    padding: var(--s-2) 0;
  }

  .floor {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
    min-width: 0;
  }
  .floor.display h1 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
  }
  .cta-primary {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cta-primary:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }

  /* Utility row — search input + Filters toggle */
  .floor.utility {
    align-items: center;
  }
  .search {
    flex: 1;
    min-width: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-13);
    font-family: var(--f-sans);
    min-height: 32px;
  }
  .search::placeholder {
    color: var(--text-3);
  }
  .search:focus {
    outline: none;
    box-shadow: var(--focus-ring);
    border-color: var(--accent);
  }
  .filters-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
    white-space: nowrap;
  }
  .filters-toggle:hover {
    border-color: var(--accent);
  }
  .filters-toggle[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .filters-toggle .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    background: var(--accent);
    color: var(--accent-text);
    border-radius: var(--r-pill);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
  .filters-toggle[data-active="1"] .count {
    background: var(--accent);
    color: var(--accent-text);
  }

  @media (prefers-reduced-motion: reduce) {
    .cta-primary,
    .filters-toggle {
      transition: none;
    }
  }
  @media (max-width: 480px) {
    .floor.display {
      flex-direction: column;
      align-items: stretch;
    }
    .cta-primary {
      align-self: flex-start;
    }
  }
</style>

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
    onOpenTrash,
    deletedCount = 0,
    query,
    onQueryChange,
    onToggleFilters,
    filtersOpen,
    activeFilterCount,
    totalCount,
    filteredCount,
    sticky = false,
    children,
  }: {
    title: string;
    view: "feed" | "trash";
    onAddEvent: () => void;
    onOpenTrash?: () => void;
    deletedCount?: number;
    query: string;
    onQueryChange: (q: string) => void;
    onToggleFilters: () => void;
    filtersOpen: boolean;
    activeFilterCount: number;
    totalCount?: number;
    filteredCount?: number;
    sticky?: boolean;
    children?: import("svelte").Snippet;
  } = $props();

  const isFiltered = $derived(
    totalCount != null && filteredCount != null && filteredCount !== totalCount,
  );

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
  <!-- Floor 1: display row — titlegroup + primary CTA. Count summary sits
       ABSOLUTELY under the H1 so its length doesn't affect layout. -->
  <div class="floor display top">
    <div class="titlegroup">
      <h1>{title}</h1>
      {#if totalCount != null}
        <span class="summary" aria-label="Event count">
          {#if isFiltered}
            <b>{filteredCount}</b> of <b>{totalCount}</b>
            {view === "trash" ? "items" : "events"}
          {:else}
            <b>{totalCount}</b> {view === "trash" ? "items" : "events"}
          {/if}
          {#if view === "trash"}<span class="sep">·</span>auto-removed in 30 days{/if}
        </span>
      {/if}
    </div>
    {#if view === "feed"}
      <button type="button" class="cta-primary" onclick={onAddEvent}>
        <span class="cta-plus" aria-hidden="true">+</span>
        <span>{m.add_event_modal_title()}</span>
      </button>
      {#if deletedCount > 0 && onOpenTrash}
        <button type="button" class="recovery-link" onclick={onOpenTrash}>
          Recently deleted ({deletedCount})
        </button>
      {/if}
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
      data-active={activeFilterCount > 0 ? "1" : "0"}
      onclick={onToggleFilters}
      aria-expanded={filtersOpen}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 5h18" />
        <path d="M6 12h12" />
        <path d="M10 19h4" />
      </svg>
      <span>{m.feed_filters_toggle_label()}</span>
      {#if activeFilterCount > 0}
        <span class="filters-count">{activeFilterCount}</span>
      {/if}
      <span class="filters-chev" data-open={filtersOpen ? "1" : "0"} aria-hidden="true">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.25"
          stroke-linecap="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
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
  .floor.top {
    gap: var(--s-4);
    align-items: flex-start;
  }
  .titlegroup {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-bottom: 26px;
  }
  .titlegroup h1 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: 1;
    letter-spacing: -0.01em;
  }
  .summary {
    position: absolute;
    bottom: 0;
    left: 0;
    white-space: nowrap;
    color: var(--text-3);
    font-size: var(--t-12);
    font-family: var(--f-mono);
    letter-spacing: 0.02em;
    line-height: 1.2;
    pointer-events: none;
  }
  .summary b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    font-weight: var(--w-md);
  }
  .summary .sep {
    color: var(--text-3);
    margin: 0 6px;
  }
  /* Add event button — ghost style per prototype `.btn.add-event`
   * (docs/design/v2/ui-kit/index.html lines 365-389): surface-2 background,
   * accent-only on the leading + icon. NOT a solid accent fill. */
  .cta-primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    min-height: 40px;
    padding: 0 var(--s-4);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta-primary .cta-plus {
    color: var(--accent);
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    line-height: 1;
    font-weight: var(--w-sb);
  }
  .cta-primary:hover {
    background: var(--surface-3, var(--surface-2));
    border-color: var(--accent);
  }
  .cta-primary:hover .cta-plus {
    color: var(--accent-strong);
  }
  /* Recovery link — text-link CTA appearing next to Add event when the
   * user has trashed items. Matches prototype .btn-link.recovery-link
   * (docs/design/v2/ui-kit/app.jsx lines 137-143). */
  .recovery-link {
    background: transparent;
    border: 0;
    padding: 0 var(--s-2);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    align-self: center;
    transition: color var(--m-fast) var(--m-ease);
  }
  .recovery-link:hover {
    color: var(--text);
  }

  /* Utility row — search input + Filters toggle */
  .floor.utility {
    align-items: center;
  }
  /* Search width-bounded per prototype `.page-head-search`
   * (docs/design/v2/ui-kit/index.html line 176-181): grows to 420px max,
   * basis 280px. Filters button sits next to it, not at far right. */
  .search {
    flex: 1 1 280px;
    max-width: 420px;
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
  /* Filters toggle — ghost button with filter icon + chevron. Per prototype
   * `.btn.filters-toggle` (docs/design/v2/ui-kit/index.html lines 249-274). */
  .filters-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    min-height: 40px;
    padding: 0 14px;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
    white-space: nowrap;
  }
  .filters-toggle:hover {
    background: var(--surface-3, var(--surface-2));
    border-color: var(--border-2, var(--accent));
  }
  .filters-toggle[data-active="1"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 40%, var(--border));
    color: var(--text);
  }
  .filters-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--accent);
    color: var(--accent-text);
    border-radius: var(--r-pill);
    font-size: 11px;
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
  .filters-chev {
    display: inline-flex;
    transition: transform var(--m-fast) var(--m-ease);
    color: var(--text-3);
  }
  .filters-chev[data-open="1"] {
    transform: rotate(180deg);
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

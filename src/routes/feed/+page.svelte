<script lang="ts">
  // /feed — primary daily workspace for authenticated users (Plan 02.1-07,
  // extended Plan 02.1-14 + 02.1-15).
  //
  // Composition (UI-SPEC §"/feed"):
  //   - <h1>Feed</h1> at heading-24 (NOT display-32) — the rows ARE the page;
  //     the heading is the label, deliberately understated.
  //   - <DateRangeControl> above the chip strip (Plan 02.1-15 — Gap 10).
  //   - <FilterChips> at min-width 600px (inline strip), collapsing to a
  //     "Filters (N)" button below 600px that opens <FiltersSheet>.
  //   - <ul> of <FeedCard> — the load-bearing surface (Plan 02.1-16
  //     replaces <FeedRow> with <FeedCard> per Gap 3 closure).
  //   - <CursorPager> at the bottom (Older →) for pagination.
  //   - <DeletedEventsPanel> below the pager (Plan 02.1-14 — Gap 2).
  //   - <EmptyState> for first-time empty + filtered-no-match cases.
  //
  // Plan 02.1-15: filter changes always reset cursor (RESEARCH §3.4 b);
  // multi-value axes use URLSearchParams.append() so repeated params survive
  // navigation. dismissAxis(axis, value?) removes ONE value from a
  // multi-select axis when value is supplied.

  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import DateRangeControl from "$lib/components/DateRangeControl.svelte";
  import FilterChips from "$lib/components/FilterChips.svelte";
  import FiltersSheet from "$lib/components/FiltersSheet.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import CursorPager from "$lib/components/CursorPager.svelte";
  import DeletedEventsPanel from "$lib/components/DeletedEventsPanel.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let sheetOpen = $state(false);
  let sheetFocusAxis = $state<
    "kind" | "source" | "show" | "authorIsMe" | undefined
  >(undefined);

  const sourceById = $derived(new Map(data.sources.map((s) => [s.id, s])));
  const gameById = $derived(new Map(data.games.map((g) => [g.id, g])));

  function hasNoActiveFilters(f: typeof data.activeFilters): boolean {
    // Plan 02.1-19: source / kind are arrays + show is a discriminated
    // union. "No filter" = all arrays empty, show.kind === 'any',
    // authorIsMe undefined, no date constraint.
    return (
      f.source.length === 0 &&
      f.kind.length === 0 &&
      f.show.kind === "any" &&
      f.authorIsMe === undefined &&
      !f.defaultDateRange &&
      f.from === undefined &&
      f.to === undefined &&
      !f.all
    );
  }

  function applyDateRange(next: { from?: string; to?: string; all?: boolean }): void {
    const params = new URLSearchParams(page.url.searchParams);
    params.delete("from");
    params.delete("to");
    params.delete("all");
    params.delete("cursor");
    if (next.all) {
      params.set("all", "1");
    } else {
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);
    }
    const qs = params.toString();
    void goto(qs ? `/feed?${qs}` : "/feed");
  }

  // Plan 02.1-19: per-axis dismiss — × on a chip clears the entire axis
  // (drops all values for that axis, NOT a single value).
  type ChipAxis = "kind" | "source" | "show" | "authorIsMe";
  function dismissAxis(axis: ChipAxis): void {
    const params = new URLSearchParams(page.url.searchParams);
    params.delete("cursor");
    if (axis === "show") {
      // Clear the show axis → land on default (any) by removing both ?show
      // and ?game params. Default 30-day window is preserved.
      params.delete("show");
      params.delete("game");
    } else if (axis === "authorIsMe") {
      params.delete("authorIsMe");
    } else if (axis === "kind") {
      params.delete("kind");
    } else if (axis === "source") {
      params.delete("source");
    }
    const qs = params.toString();
    void goto(qs ? `/feed?${qs}` : "/feed");
  }

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "specific"; gameIds: string[] };

  function applyFiltersFromSheet(next: {
    source?: string[];
    kind?: string[];
    show: ShowFilter;
    authorIsMe?: boolean;
  }): void {
    const params = new URLSearchParams(page.url.searchParams);
    // Sheet owns source/kind/show/authorIsMe; the date-range params belong
    // to <DateRangeControl> and are PRESERVED here.
    params.delete("source");
    params.delete("kind");
    params.delete("game");
    params.delete("show");
    params.delete("authorIsMe");
    params.delete("cursor");
    for (const v of next.source ?? []) params.append("source", v);
    for (const v of next.kind ?? []) params.append("kind", v);
    if (next.show.kind === "inbox") {
      params.set("show", "inbox");
    } else if (next.show.kind === "specific") {
      params.set("show", "specific");
      for (const v of next.show.gameIds) params.append("game", v);
    }
    // show.kind === "any": no params (default).
    if (next.authorIsMe === true) params.set("authorIsMe", "true");
    if (next.authorIsMe === false) params.set("authorIsMe", "false");
    const qs = params.toString();
    void goto(qs ? `/feed?${qs}` : "/feed");
  }

  function clearAll(): void {
    // Clear every filter — including the date range. Land on ?all=1 so the
    // 30-day default doesn't immediately re-apply.
    void goto("/feed?all=1");
  }

  function gotoNextPage(): void {
    if (!data.nextCursor) return;
    const params = new URLSearchParams(page.url.searchParams);
    params.set("cursor", data.nextCursor);
    void goto(`/feed?${params.toString()}`);
  }
</script>

<section class="feed">
  <header class="head">
    <h1>Feed</h1>
    <a href="/events/new" class="cta">{m.feed_cta_add_event()}</a>
  </header>

  <DateRangeControl activeFilters={data.activeFilters} onApply={applyDateRange} />

  {#if data.rows.length === 0 && hasNoActiveFilters(data.activeFilters)}
    <EmptyState heading={m.empty_feed_heading()} body={m.empty_feed_body()} />
  {:else if data.rows.length === 0}
    <FilterChips
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      onDismiss={dismissAxis}
      onOpenSheet={(axis) => {
        sheetFocusAxis = axis;
        sheetOpen = true;
      }}
      onClearAll={clearAll}
    />
    <EmptyState heading={m.empty_feed_filtered_heading()} body={m.empty_feed_filtered_body()} />
  {:else}
    <FilterChips
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      onDismiss={dismissAxis}
      onOpenSheet={(axis) => {
        sheetFocusAxis = axis;
        sheetOpen = true;
      }}
      onClearAll={clearAll}
    />
    <ul class="feed-list">
      {#each data.rows as row (row.id)}
        <li>
          <FeedCard
            event={row}
            source={row.sourceId ? (sourceById.get(row.sourceId) ?? null) : null}
            game={row.gameId ? (gameById.get(row.gameId) ?? null) : null}
            games={data.games}
            onChanged={() => invalidateAll()}
          />
        </li>
      {/each}
    </ul>
    <CursorPager
      hasNext={data.nextCursor !== null}
      hasPrev={false}
      onNext={gotoNextPage}
      onPrev={() => {}}
    />
  {/if}

  <!-- Plan 02.1-14 (gap closure) — soft-delete recovery panel sits below
       CursorPager. The component returns nothing when there are no recoverable
       events, so it has zero footprint on the empty-feed and filtered-empty
       branches above. -->
  <DeletedEventsPanel
    deletedEvents={data.deletedEvents}
    retentionDays={data.retentionDays}
    onChanged={() => invalidateAll()}
  />

  {#if sheetOpen}
    <FiltersSheet
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      focusAxis={sheetFocusAxis}
      onApply={(next) => {
        sheetOpen = false;
        sheetFocusAxis = undefined;
        applyFiltersFromSheet(next);
      }}
      onClose={() => {
        sheetOpen = false;
        sheetFocusAxis = undefined;
      }}
    />
  {/if}
</section>

<style>
  .feed {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
  }
  .head h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
  }
  .cta {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-on-accent, #fff);
    border-radius: 4px;
    text-decoration: none;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
  }
  .cta:hover {
    filter: brightness(1.05);
  }
  .feed-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .feed-list > li {
    border-bottom: 1px solid var(--color-border);
  }
</style>

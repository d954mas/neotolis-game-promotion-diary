<script lang="ts">
  // /feed — primary daily workspace for authenticated users (Plan 02.1-07,
  // extended Plan 02.1-14 + 02.1-15; Plan 02.1-19 round-2 UAT rebuild).
  //
  // Composition (Plan 02.1-19):
  //   - <h1>Feed</h1> at heading-24.
  //   - <DateRangeControl> with always-visible from/to inputs + 4 presets +
  //     × clear (Plan 02.1-15 Custom toggle dropped).
  //   - <FilterChips> emits one chip per active axis (kind / source / show /
  //     authorIsMe), comma-joined values; click opens FiltersSheet on that
  //     axis; × clears entire axis.
  //   - <FeedDateGroupHeader> + <FeedCard> tiles in a CSS grid
  //     (auto-fill, minmax 280px) — Google Photos / Apple Photos timeline.
  //   - Sentinel <div> drives IntersectionObserver-based infinite scroll
  //     (replaces <CursorPager>).
  //   - <DeletedEventsPanel> below the grid (Plan 02.1-14 — Gap 2; the panel
  //     keeps its own pagination — recovery is a different mental model).
  //   - <EmptyState> for first-time empty + filtered-no-match cases.
  //
  // Plan 02.1-19 a11y note: infinite scroll has no JavaScript-disabled
  // fallback in 2.1. Screen-reader users can still scroll the rendered first
  // page; subsequent pages require IntersectionObserver. A "Load more"
  // button fallback is filed as Phase 6 polish if user feedback surfaces it.
  // The role="status" on the loading + end banners ensures assistive tech
  // announces state changes.

  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import DateRangeControl from "$lib/components/DateRangeControl.svelte";
  import FilterChips from "$lib/components/FilterChips.svelte";
  import FiltersSheet from "$lib/components/FiltersSheet.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import DeletedEventsPanel from "$lib/components/DeletedEventsPanel.svelte";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let sheetOpen = $state(false);
  // Plan 02.1-20 widens FilterChips/FiltersSheet axis union to include
  // 'action' for /audit reuse; /feed never receives that axis (filters.action
  // is left undefined here) but the local type must match the component
  // contract. Plan 02.1-21 adds 'date' to the union (in-sheet secondary
  // entry; the always-visible <DateRangeControl> stays the primary).
  let sheetFocusAxis = $state<
    "kind" | "source" | "show" | "authorIsMe" | "date" | "action" | undefined
  >(undefined);

  // Plan 02.1-21: schema is the explicit list of axes /feed owns. Replaces
  // FiltersSheet's old implicit "render everything" default. Behavior is
  // unchanged for end users — kind/source/show/authorIsMe/date are all
  // rendered in the sheet exactly as before; the explicit list is just a
  // forward-compatible API for adding axes in Phase 3+.
  const FEED_SCHEMA = ["kind", "source", "show", "authorIsMe", "date"] as const;

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
  // Plan 02.1-20: 'action' is part of the FilterChips axis union for /audit
  // reuse but is unreachable here (/feed never sets filters.action).
  type ChipAxis = "kind" | "source" | "show" | "authorIsMe" | "action";
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
    } else if (axis === "action") {
      // /feed never carries an 'action' chip — defensive no-op.
      return;
    }
    const qs = params.toString();
    void goto(qs ? `/feed?${qs}` : "/feed");
  }

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "standalone" }
    | { kind: "specific"; gameIds: string[] };

  function applyFiltersFromSheet(next: {
    source?: string[];
    kind?: string[];
    // Plan 02.1-20: FiltersSheet's onApply widens show to optional so /audit
    // can omit it. /feed always supplies it; default to { kind: 'any' } when
    // the sheet returns undefined (defensive).
    show?: ShowFilter;
    authorIsMe?: boolean;
    // Plan 02.1-21: schema=['kind','source','show','authorIsMe','date'] for
    // /feed → the sheet's in-sheet date axis can emit from/to. The primary
    // entry remains <DateRangeControl> above the chip strip; the sheet path
    // is the secondary entry for users opening the sheet from a chip click.
    from?: string;
    to?: string;
    action?: string[];  // unused on /feed
  }): void {
    const params = new URLSearchParams(page.url.searchParams);
    // Sheet owns source/kind/show/authorIsMe (always), and date (when
    // schema includes 'date' — true for /feed). Plan 02.1-21: when the
    // sheet emits from/to (or omits both), we honor it as the new
    // date-range source of truth — same shape as <DateRangeControl>.
    params.delete("source");
    params.delete("kind");
    params.delete("game");
    params.delete("show");
    params.delete("authorIsMe");
    params.delete("cursor");
    // Plan 02.1-21: only rewrite from/to if the sheet emitted them (i.e.
    // schema includes 'date'). The sheet's clearAll sends from=undefined
    // + to=undefined → we drop both params and ?all=1 lands the user on
    // the no-default-window state to match clearAll's intent.
    if ("from" in next || "to" in next) {
      params.delete("from");
      params.delete("to");
      params.delete("all");
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);
      // If the sheet sent neither value, preserve the no-default state.
      if (!next.from && !next.to) params.set("all", "1");
    }
    for (const v of next.source ?? []) params.append("source", v);
    for (const v of next.kind ?? []) params.append("kind", v);
    const show: ShowFilter = next.show ?? { kind: "any" };
    if (show.kind === "inbox") {
      params.set("show", "inbox");
    } else if (show.kind === "standalone") {
      // Plan 02.1-24: standalone filter axis.
      params.set("show", "standalone");
    } else if (show.kind === "specific") {
      params.set("show", "specific");
      for (const v of show.gameIds) params.append("game", v);
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

  // Plan 02.1-19: cumulative rows for infinite scroll. data.rows is the
  // first page from the loader; loadMore() appends next pages via fetch.
  let allRows = $state(data.rows);
  let nextCursor = $state<string | null>(data.nextCursor);
  let loading = $state(false);
  let endReached = $state(data.nextCursor === null);
  let sentinelEl = $state<HTMLDivElement | null>(null);
  let observer: IntersectionObserver | null = null;

  // Reset cumulative state when data changes (filter change → fresh load
  // → new first page). The $effect re-runs whenever any reactive read
  // inside it changes, so reading data.rows + data.nextCursor here is the
  // load-bearing tripwire for "the loader re-ran".
  $effect(() => {
    allRows = data.rows;
    nextCursor = data.nextCursor;
    endReached = data.nextCursor === null;
    loading = false;
  });

  const groupedRows = $derived(groupEventsByDate(allRows));

  async function loadMore(): Promise<void> {
    if (loading || endReached || !nextCursor) return;
    loading = true;
    try {
      const params = new URLSearchParams(page.url.searchParams);
      params.set("cursor", nextCursor);
      const res = await fetch(`/api/events?${params.toString()}`);
      if (!res.ok) {
        // On error, stop trying — user can refresh manually. Phase 4 may
        // add a toast retry banner.
        endReached = true;
        return;
      }
      const body = (await res.json()) as {
        rows: typeof data.rows;
        nextCursor: string | null;
      };
      allRows = [...allRows, ...body.rows];
      nextCursor = body.nextCursor;
      if (body.nextCursor === null) endReached = true;
    } catch {
      endReached = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!sentinelEl) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelEl);
    return () => observer?.disconnect();
  });
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
      schema={FEED_SCHEMA}
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
      schema={FEED_SCHEMA}
      onDismiss={dismissAxis}
      onOpenSheet={(axis) => {
        sheetFocusAxis = axis;
        sheetOpen = true;
      }}
      onClearAll={clearAll}
    />
    <div class="feed-grid">
      {#each groupedRows as group (group.date)}
        <FeedDateGroupHeader occurredAt={group.occurredAt} />
        {#each group.rows as row (row.id)}
          <FeedCard
            event={row}
            source={row.sourceId ? (sourceById.get(row.sourceId) ?? null) : null}
            game={row.gameId ? (gameById.get(row.gameId) ?? null) : null}
            games={data.games}
            onChanged={() => invalidateAll()}
          />
        {/each}
      {/each}
      {#if !endReached}
        <div class="sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
        {#if loading}
          <p class="feed-status" role="status">{m.feed_loading_more()}</p>
        {/if}
      {:else if allRows.length > 0}
        <p class="feed-status feed-end" role="status">{m.feed_no_more_events()}</p>
      {/if}
    </div>
  {/if}

  <!-- Plan 02.1-14 (gap closure) — soft-delete recovery panel sits below
       the feed grid (was: below CursorPager pre-Plan-02.1-19). The
       component returns nothing when there are no recoverable events, so
       it has zero footprint on the empty-feed and filtered-empty branches
       above. -->
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
      schema={FEED_SCHEMA}
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
  /* Plan 02.1-19: CSS grid (auto-fill, minmax 280px) replaces the Plan
   * 02.1-15 vertical list. Multi-column on >=640px; single column below.
   * <FeedDateGroupHeader> sets `grid-column: 1 / -1` so the header spans
   * the full row, separating card groups visually. */
  .feed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-md);
    margin: 0;
    padding: 0;
  }
  @media (max-width: 639px) {
    /* Force single-column on mobile (auto-fill collapses naturally below
     * ~280px + gutter, but force it across 360-639px per UAT gap "single
     * column on <640px"). */
    .feed-grid {
      grid-template-columns: 1fr;
    }
  }
  .sentinel {
    width: 100%;
    height: 1px;
    grid-column: 1 / -1;
  }
  .feed-status {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    padding: var(--space-md) 0;
    margin: 0;
  }
</style>

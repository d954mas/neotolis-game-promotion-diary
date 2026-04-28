<script lang="ts">
  // /feed — primary daily workspace for authenticated users (Plan 02.1-07).
  //
  // Composition (UI-SPEC §"/feed"):
  //   - <h1>Feed</h1> at heading-24 (NOT display-32) — the rows ARE the page;
  //     the heading is the label, deliberately understated.
  //   - <FilterChips> at min-width 600px (inline strip), collapsing to a
  //     "Filters (N)" button below 600px that opens <FiltersSheet>.
  //   - <ul> of <FeedRow> — the load-bearing surface.
  //   - <CursorPager> at the bottom (Older →) for pagination.
  //   - <EmptyState> for first-time empty + filtered-no-match cases.
  //
  // Filter changes always reset cursor (RESEARCH §3.4 b). All copy via
  // Paraglide m.* (D-41). No hard-coded English literals beyond the single
  // "Feed" heading (UI-SPEC notes the heading is structural and not in the
  // budget).

  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import FeedRow from "$lib/components/FeedRow.svelte";
  import FilterChips from "$lib/components/FilterChips.svelte";
  import FiltersSheet from "$lib/components/FiltersSheet.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import CursorPager from "$lib/components/CursorPager.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let sheetOpen = $state(false);

  const sourceById = $derived(new Map(data.sources.map((s) => [s.id, s])));
  const gameById = $derived(new Map(data.games.map((g) => [g.id, g])));

  function hasNoActiveFilters(f: typeof data.activeFilters): boolean {
    return (
      f.source === undefined &&
      f.kind === undefined &&
      f.game === undefined &&
      f.attached === undefined &&
      f.authorIsMe === undefined &&
      f.from === undefined &&
      f.to === undefined
    );
  }

  function buildUrl(next: Record<string, string | boolean | undefined>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") continue;
      params.set(k, String(v));
    }
    // Filter changes always reset cursor (RESEARCH §3.4 b).
    params.delete("cursor");
    const qs = params.toString();
    return qs.length > 0 ? `/feed?${qs}` : "/feed";
  }

  function applyFilters(next: Record<string, string | boolean | undefined>): void {
    void goto(buildUrl(next));
  }

  function dismissAxis(axis: string): void {
    const current: Record<string, string | boolean | undefined> = {
      source: data.activeFilters.source,
      kind: data.activeFilters.kind,
      game: data.activeFilters.game,
      attached: data.activeFilters.attached,
      authorIsMe: data.activeFilters.authorIsMe,
      from: data.activeFilters.from,
      to: data.activeFilters.to,
    };
    delete current[axis];
    applyFilters(current);
  }

  function clearAll(): void {
    void goto("/feed");
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

  {#if data.rows.length === 0 && hasNoActiveFilters(data.activeFilters)}
    <EmptyState heading={m.empty_feed_heading()} body={m.empty_feed_body()} />
  {:else if data.rows.length === 0}
    <FilterChips
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      onDismiss={dismissAxis}
      onOpenSheet={() => (sheetOpen = true)}
      onClearAll={clearAll}
    />
    <EmptyState heading={m.empty_feed_filtered_heading()} body={m.empty_feed_filtered_body()} />
  {:else}
    <FilterChips
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      onDismiss={dismissAxis}
      onOpenSheet={() => (sheetOpen = true)}
      onClearAll={clearAll}
    />
    <ul class="feed-list">
      {#each data.rows as row (row.id)}
        <li>
          <FeedRow
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

  {#if sheetOpen}
    <FiltersSheet
      filters={data.activeFilters}
      sources={data.sources}
      games={data.games}
      onApply={(next) => {
        sheetOpen = false;
        applyFilters(next);
      }}
      onClose={() => (sheetOpen = false)}
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

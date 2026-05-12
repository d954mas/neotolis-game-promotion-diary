<script lang="ts">
  // /feed — primary daily workspace for authenticated users.
  //
  // Composition:
  //   - <h1>Feed</h1> at heading-24.
  //   - <DateRangeControl> with always-visible from/to inputs + 4
  //     presets + × clear.
  //   - <FilterChips> emits one chip per active axis (kind / source /
  //     show / authorIsMe), comma-joined values; click opens
  //     FiltersSheet on that axis; × clears entire axis.
  //   - <FeedDateGroupHeader> + <FeedCard> tiles in a CSS grid
  //     (auto-fill, minmax 280px) — Google Photos / Apple Photos timeline.
  //   - Sentinel <div> drives IntersectionObserver-based infinite scroll.
  //   - <RecoveryDialog> modal opened from PageHeader's "Recently
  //     deleted (N)" button (a dialog rather than an anchor so infinite
  //     scroll does not throw the user to a moving target).
  //   - <EmptyState> for first-time empty + filtered-no-match cases.
  //
  // a11y note: infinite scroll has no JavaScript-disabled fallback.
  // Screen-reader users can still scroll the rendered first page;
  // subsequent pages require IntersectionObserver. A "Load more" button
  // fallback is a future polish if user feedback surfaces it. The
  // role="status" on the loading + end banners ensures assistive tech
  // announces state changes.

  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";
  import FeedCard from "$lib/components/FeedCard.svelte";
  // Escape hatch — adapter-specific card override. YouTube uses the
  // universal FeedCard. Other source kinds may register `cardComponent`
  // on their sources/<kind>/ui/index.ts to opt into a custom layout.
  import { getCardComponent } from "$lib/sources/registry-ui-client.js";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import FeedQuickNav from "$lib/components/FeedQuickNav.svelte";
  // Shared PageHeader replaces the inline <header class="head"> + .cta
  // block — title + CTA inline on the left instead of
  // justify-content: space-between.
  import PageHeader from "$lib/components/PageHeader.svelte";
  import DateRangeControl from "$lib/components/DateRangeControl.svelte";
  import FilterChips from "$lib/components/FilterChips.svelte";
  import FiltersSheet from "$lib/components/FiltersSheet.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  // <RecoveryDialog> modal opens from PageHeader's "Recently deleted (N)"
  // button. A bottom-of-page panel broke on infinite-scroll surfaces by
  // construction (anchor link → scroll to bottom → sentinel fires →
  // bottom moves → user lost). The dialog decouples the recovery UI from
  // scroll position. The soft-deleted events flow comes from the same
  // loader (data.deletedEvents) and renders inside the modal.
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let sheetOpen = $state(false);
  // RecoveryDialog open state. Opened by PageHeader's "Recently deleted (N)"
  // button; closed by Escape, backdrop click, or the dialog's own close
  // button. Auto-closes when the last recoverable item is restored
  // (items reactively shrink to length 0).
  let recoveryOpen = $state(false);

  // Map deletedEvents (toEventDto-projected, no ciphertext) into the
  // RecoveryDialog's generic { id, name, deletedAt } shape. The DTO
  // contract guarantees `title` exists; `deletedAt` is the soft-delete
  // timestamp — same field RetentionBadge consumes inside the dialog.
  const recoveryItems = $derived(
    data.deletedEvents.map((ev) => ({
      id: ev.id,
      name: ev.title,
      deletedAt: ev.deletedAt,
    })),
  );

  async function restoreEvent(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    if (res.ok) {
      await invalidateAll();
      // If that was the last recoverable item, close the dialog so the
      // user is not stuck staring at "Nothing to recover" — the parent
      // also stops rendering the PageHeader CTA at the same time
      // (deletedCount falls to 0).
      if (data.deletedEvents.length <= 1) recoveryOpen = false;
    }
  }
  // FilterChips/FiltersSheet's axis union includes 'action' for /audit
  // reuse; /feed never receives that axis (filters.action is left
  // undefined here) but the local type must match the component contract.
  // 'date' stays in the union so the type still flows through
  // FiltersSheet/FilterChips on other surfaces (e.g. /audit), even
  // though /feed itself owns the date range via <DateRangeControl>.
  let sheetFocusAxis = $state<
    "kind" | "source" | "show" | "authorIsMe" | "date" | "action" | undefined
  >(undefined);

  // FEED_SCHEMA is the explicit list of axes /feed owns. The
  // always-visible <DateRangeControl> above the chip strip is the SOLE
  // date-range entry on /feed; 'date' is intentionally excluded from
  // this schema so FiltersSheet skips the date fieldset AND its clearAll
  // skips the date axis.
  //
  // Both "Clear filters" surfaces (chip-strip clearAll() below + in-
  // sheet) preserve the date range. Date is owned exclusively by
  // <DateRangeControl>; both "Clear filters" buttons clear ONLY the
  // chip-owned axes (kind / source / show / game / authorIsMe / cursor).
  const FEED_SCHEMA = ["kind", "source", "show", "authorIsMe"] as const;

  const sourceById = $derived(new Map(data.sources.map((s) => [s.id, s])));
  const gameById = $derived(new Map(data.games.map((g) => [g.id, g])));

  function hasNoActiveFilters(f: typeof data.activeFilters): boolean {
    // source / kind are arrays + show is a discriminated union. "No
    // filter" = all arrays empty, show.kind === 'any', authorIsMe
    // undefined, no date constraint.
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

  // Per-axis dismiss — × on a chip clears the entire axis (drops all
  // values for that axis, NOT a single value). 'action' is part of the
  // FilterChips axis union for /audit reuse but is unreachable here
  // (/feed never sets filters.action).
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
    // FiltersSheet's onApply widens show to optional so /audit can omit
    // it. /feed always supplies it; default to { kind: 'any' } when the
    // sheet returns undefined (defensive).
    show?: ShowFilter;
    authorIsMe?: boolean;
    // FiltersSheet's onApply contract is shared with /audit, which DOES
    // use 'date' via its own schema. With FEED_SCHEMA missing 'date',
    // the sheet never emits these on /feed — the
    // `"from" in next || "to" in next` gate below is what makes the
    // omission a no-op for the date params.
    from?: string;
    to?: string;
    action?: string[]; // unused on /feed
  }): void {
    const params = new URLSearchParams(page.url.searchParams);
    // Sheet owns source/kind/show/authorIsMe on /feed. The
    // <DateRangeControl> above the chip strip is the sole date entry.
    params.delete("source");
    params.delete("kind");
    params.delete("game");
    params.delete("show");
    params.delete("authorIsMe");
    params.delete("cursor");
    // Only rewrite from/to if the sheet emitted them (i.e. schema
    // includes 'date'). This branch is a no-op on /feed — the user's
    // date range survives the sheet's apply/clearAll round-trip
    // (DateRangeControl owns the axis). The gate is preserved so the
    // same handler shape stays compatible if a future surface
    // re-introduces 'date' in its schema.
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
      // Standalone (not attached to any game) filter axis.
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
    // Wired to <FilterChips onClearAll>. Both "Clear filters" surfaces
    // (in-sheet + chip-strip) clear chip-owned axes
    // (kind / source / show / game / authorIsMe / cursor) and PRESERVE
    // the user's selected date range (?from / ?to / ?all).
    //
    // Date is owned exclusively by <DateRangeControl>; the only way to
    // change the date range is to interact with that control directly
    // (presets, from/to inputs, or its own × reset button). The mental
    // model: the date range is established BEFORE picking filters and
    // survives every filter operation.
    const params = new URLSearchParams(page.url.search);
    // Drop chip-owned axes only.
    params.delete("kind");
    params.delete("source");
    params.delete("show");
    params.delete("game");
    params.delete("authorIsMe");
    params.delete("cursor");
    // ?from, ?to, ?all are preserved by virtue of NOT deleting them.
    const qs = params.toString();
    void goto(qs ? `/feed?${qs}` : "/feed");
  }

  // Cumulative rows for infinite scroll. data.rows is the first page
  // from the loader; loadMore() appends next pages via fetch.
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
        // On error, stop trying — user can refresh manually.
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
  <PageHeader
    title="Feed"
    cta={{ href: "/events/new", label: m.feed_cta_add_event() }}
    sticky
    deletedCount={data.deletedEvents.length}
    onOpenRecovery={() => (recoveryOpen = true)}
  />

  <!-- FeedQuickNav: chip strip / segmented control for the most-common
       Show axis values (All / Inbox / Standalone / per-game). The user
       wants a single-click switch instead of opening FiltersSheet. The
       full FiltersSheet stays for long-tail filters (kind, source, date,
       authorIsMe). -->
  <FeedQuickNav
    games={data.games}
    activeShow={data.activeFilters.show}
    currentUrlSearch={page.url.search}
    onNavigate={(href) => {
      void goto(href).then(() => invalidateAll());
    }}
  />

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
          {@const Card = getCardComponent(row.kind) ?? FeedCard}
          <Card
            event={row}
            source={row.sourceId ? (sourceById.get(row.sourceId) ?? null) : null}
            game={row.gameIds.length > 0 ? (gameById.get(row.gameIds[0]!) ?? null) : null}
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

  <!-- The recovery flow lives in <RecoveryDialog> — a modal opened from
       PageHeader's "Recently deleted (N)" button. The dialog decouples
       the recovery UI from scroll position so infinite-scroll does not
       throw the user to a moving target. The dialog only mounts when
       data.deletedEvents.length > 0; the dialog itself still defends
       against the empty case (renders the localized empty message). -->
  {#if data.deletedEvents.length > 0}
    <RecoveryDialog
      open={recoveryOpen}
      items={recoveryItems}
      entityType="event"
      retentionDays={data.retentionDays}
      onClose={() => (recoveryOpen = false)}
      onRestore={restoreEvent}
    />
  {/if}

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
  /* Inline .head + .cta CSS removed — replaced by the shared
   * <PageHeader> component (see top of file). The shared component uses
   * the inline-on-the-left flex layout instead of
   * justify-content: space-between. */
  /* CSS grid (auto-fill, minmax 280px) for the timeline. Multi-column
   * on >=640px; single column below. <FeedDateGroupHeader> sets
   * `grid-column: 1 / -1` so the header spans the full row, separating
   * card groups visually. */
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

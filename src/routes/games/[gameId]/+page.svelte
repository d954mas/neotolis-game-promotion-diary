<script lang="ts">
  // /games/[gameId] — detail view.
  //
  // PageHeader.title carries a single edit affordance (PageHeader.cta opens
  // GameEditDialog). GameEditDialog provides title input + description
  // textarea + Save / Cancel. On Save it PATCHes /api/games/:id with both
  // fields and invalidateAll() refreshes the loader.
  //
  // The description (when set) renders in the .game-info section after the
  // meta row, with `white-space: pre-wrap` so newlines from the textarea
  // survive the round-trip. When NULL, nothing renders — the empty state
  // is invisible (the user can always click Edit to add one).
  //
  // The Add Store CTA lives next to the Stores h2 in the section-header
  // row; clicking it opens AddStoreDialog (a modal wrapping the existing
  // AddSteamListingForm). StoresSection is a pure list renderer; the page
  // owns the Add modal lifecycle.
  //
  // Privacy invariants:
  //   - Loader uses tenant-scoped service calls (listEventsForGame +
  //     mapEventsToDtos).
  //   - DELETE /api/games/:gameId/listings/:listingId uses cross-tenant 404.
  //   - PATCH /api/games/:id (now carrying description) uses the same
  //     tenant-scoped updateGame service — cross-tenant 404 invariant
  //     exercised in tests/integration/games.test.ts.

  import { invalidateAll, goto } from "$app/navigation";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import NotesEditorModal from "$lib/components/shared/NotesEditorModal.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import StoresSection from "$lib/components/StoresSection.svelte";
  // GameCover removed from this page. User: "после названия игры идет
  // огромная картинка, мне не нравится. Она тут лишняя, она есть в карточки
  // стора". The cover already surfaces on each SteamListingRow, so rendering
  // it AGAIN at the top of /games/[gameId] is duplicate visual weight.
  // Component file kept in src/lib/components for future reuse on /games
  // list page or preview surfaces.
  // PageHeader replaced by inline .game-header with Edit + ⋮ side by side.
  import GameEditDialog from "$lib/components/GameEditDialog.svelte";
  import AddStoreDialog from "$lib/components/AddStoreDialog.svelte";
  // Per-game soft-deleted listings render in a ?view=trash view (mirrors
  // /games?view=trash) using SteamListingRow's trash mode — RecoveryDialog
  // replaced per UAT (Plan 03.2-04).
  import SteamListingRow from "$lib/components/SteamListingRow.svelte";
  import WishlistCorrelationChart from "$lib/components/charts/WishlistCorrelationChart.svelte";
  import WishlistGrowthChart from "$lib/components/charts/WishlistGrowthChart.svelte";
  import EventDayModal from "$lib/components/charts/EventDayModal.svelte";
  import ChartLegend from "$lib/components/charts/ChartLegend.svelte";
  import { listingLabel, eventDay, inRange } from "$lib/components/charts/wishlist-chart-shared.js";
  import DateRangeRow from "$lib/components/feed/DateRangeRow.svelte";
  import { startOfDay, dateRangeWindow, parseEventDate } from "$lib/feed/date-range.js";
  import type { DateRangeFilter } from "$lib/feed/url-state.js";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";
  import type {
    GameSteamListingDto,
    EventDto,
    WishlistSeries,
    WishlistDelta,
  } from "$lib/server/dto.js";
  import type { PageData } from "./$types";

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other"
    | "post";

  type EventDtoLocal = {
    id: string;
    kind: EventKind;
    occurredAt: Date | string;
    title: string;
    url: string | null;
    gameIds: string[];
    sourceId: string | null;
    authorIsMe: boolean;
    metadata: unknown;
    publishedAt: Date | string | null;
    lastPolledAt: Date | string | null;
    // PollingBadge reads tier inputs from youtube_videos via the loader's
    // JOIN. publishedAt is null until channel-context-backfill completes
    // (PollingBadge shows 'pending' badge for that brief window).
    lastPollStatus: string | null;
    externalId: string | null;
    notes: string | null;
  };

  type ListingDto = GameSteamListingDto;

  type SourceLite = {
    id: string;
    displayName: string | null;
    handleUrl: string;
  };

  type GameLite = {
    id: string;
    title: string;
  };

  let { data }: { data: PageData & { retentionDays: number } } = $props();

  // ?view=trash conditional (mirrors /games/+page.svelte trashView).
  const trashView = $derived(data.view === "trash");

  const game = $derived(data.game);
  const listings = $derived(data.listings as ListingDto[]);
  const deletedListings = $derived(data.deletedListings as ListingDto[]);
  const events = $derived(data.events as EventDtoLocal[]);
  const allGames = $derived(data.games as GameLite[]);
  const sources = $derived(data.sources as SourceLite[]);

  const sourceById = $derived.by(() => {
    const map = new Map<string, SourceLite>();
    for (const s of sources) map.set(s.id, s);
    return map;
  });

  const gameById = $derived(new Map(allGames.map((g) => [g.id, g])));

  // Open-state of the <GameEditDialog>. PageHeader's cta opens it.
  let editGameOpen = $state(false);

  // Open-state of the <AddStoreDialog> modal. The Add CTA next to the
  // Stores h2 toggles it; the dialog's onSuccess closes it + invalidateAll().
  let addStoreOpen = $state(false);

  // VIZ-02 == VIZ-03 (D-12): ONE correlation chart for this game. The
  // wishlist data is per-Steam-listing; the chart renders ONE line per active
  // listing (decision: separate line per store, NOT a summed line — Steam +
  // itch are different units), with a legend toggle + a date-range filter.
  // No CSV / no listing → the D-08 empty-state CTA renders while the event
  // markers still render. The full maps + listings are threaded straight
  // through (no collapse to a single listing).
  const chartSeriesByListing = $derived(
    data.wishlistSeriesByListing as Record<string, WishlistSeries>,
  );
  const chartDeltaByDate = $derived(
    data.deltaByDate as Record<string, Record<string, WishlistDelta>>,
  );
  const chartListings = $derived(
    listings.map((l) => ({ id: l.id, name: l.name, appId: l.appId })),
  );
  // The custom <ChartLegend> (04-09) renders one pill chip per active listing.
  // Resolve each label here (same fallbacks as the charts) so the legend, the
  // line, and the bar all read the same name + the same stable color. Only
  // listings that HAVE wishlist data get a chip — a no-CSV listing has no
  // series to toggle.
  const legendListings = $derived(
    chartListings
      .filter((l) => (chartSeriesByListing[l.id]?.points.length ?? 0) > 0)
      .map((l) => ({
        id: l.id,
        label: listingLabel(
          l,
          (appId) => m.viz_legend_listing_fallback({ appId }),
          () => m.viz_wishlist_line_label(),
        ),
      })),
  );
  // The loader returns full EventDtos; the page's EventDtoLocal is a subset
  // for the FeedCard renderer. The chart consumes the full DTOs for its markers.
  const chartEvents = $derived(data.events as EventDto[]);

  // ── Shared chart state (04-08) ───────────────────────────────────────
  // The date-range picker and the per-listing legend selection are OWNED HERE
  // so the cumulative correlation chart and the daily-growth bar chart stay in
  // sync: both read `chartRange` + `chartVisible`. The range filters client-side
  // against the SERVER `today` instant (D-24), never the client clock.
  const chartTodayDate = $derived(startOfDay(new Date(data.today)));
  // The chart date control is the feed's preset picker (DateRangeRow): All time
  // / Year / Month / Week / Today + a custom range. The selected preset is the
  // source of truth; the charts consume a resolved {from,to}|null window, so we
  // derive `chartRange` from the preset against the server `today` (D-24).
  let chartDateRange = $state<DateRangeFilter>({ preset: "all" });
  const chartRange = $derived.by((): { from: Date; to: Date } | null => {
    if (chartDateRange.preset === "all") return null;
    if (chartDateRange.preset === "custom") {
      const from = parseEventDate(chartDateRange.from);
      const to = parseEventDate(chartDateRange.to);
      if (!from || !to) return null;
      return { from, to };
    }
    return dateRangeWindow(chartDateRange.preset, chartTodayDate);
  });
  // The chart's selected window ({from,to}|null) — the SAME value the charts
  // consume. Aliased for the feed-range sync below so the read site reads as
  // intent.
  const chartRangeWindow = $derived(chartRange);

  // The events feed BELOW the charts respects the chart's date range: filter
  // the page's events by the SAME window the charts use (client-side on the
  // already-loaded events — no loader/service change), then group by date.
  // "All time" (null window) shows everything. Reuses inRange/eventDay so the
  // feed-list filter matches the chart's marker filter exactly (a day with a
  // marker on the chart has its events in the feed and vice-versa).
  const feedEvents = $derived(
    chartRangeWindow === null
      ? events
      : events.filter((e) => inRange(eventDay(e), chartRangeWindow)),
  );
  const groupedEvents = $derived(groupEventsByDate(feedEvents));

  // listingId → shown. Absent / true = shown; false = legend-toggled-off.
  let chartVisible = $state<Record<string, boolean>>({});
  function toggleListing(listingId: string, shown: boolean): void {
    chartVisible = { ...chartVisible, [listingId]: shown };
  }

  // ── Day-detail modal (04-10 / 04-12 cluster) ─────────────────────────
  // A marker (cluster) tap on the correlation chart emits the cluster's day(s)
  // up here; the growth chart still emits a single day (wrapped to [day]). The
  // PAGE owns the centered EventDayModal (it has the feed data — events +
  // source/game maps). Empty = closed.
  let selectedChartDays = $state<string[]>([]);
  // Those days' events — the page's FeedCard-shaped `events` filtered to the
  // selected day set (local-tz YYYY-MM-DD, matching the marker day keys).
  const selectedDayEvents = $derived.by((): EventDtoLocal[] => {
    if (selectedChartDays.length === 0) return [];
    const set = new Set(selectedChartDays);
    return events.filter((e) => set.has(eventDay(e)));
  });
  // The day-level delta (D-05) — only meaningful for a SINGLE-day cluster (which
  // day's delta otherwise?). The first VISIBLE listing's delta for that day,
  // falling back across visible listings (mirrors the charts' selection logic).
  const selectedDayDelta = $derived.by((): WishlistDelta | null => {
    if (selectedChartDays.length !== 1) return null;
    const day = selectedChartDays[0]!;
    for (const l of chartListings) {
      if (chartVisible[l.id] === false) continue;
      const d = chartDeltaByDate[l.id]?.[day];
      if (d) return d;
    }
    return null;
  });

  // Trash view: per-card Restore.
  async function restoreListing(listingId: string): Promise<void> {
    const res = await fetch(`/api/games/${game.id}/listings/${listingId}/restore`, {
      method: "POST",
    });
    if (res.ok) await invalidateAll();
  }

  // Trash view: per-card Delete forever (hard purge) → ConfirmDialog →
  // DELETE ?force=true.
  let deleteForeverId = $state<string | null>(null);
  let confirmDeleteForeverOpen = $state(false);

  function askDeleteForever(listingId: string): void {
    deleteForeverId = listingId;
    confirmDeleteForeverOpen = true;
  }

  async function confirmDeleteForever(): Promise<void> {
    if (!deleteForeverId) return;
    confirmDeleteForeverOpen = false;
    const res = await fetch(`/api/games/${game.id}/listings/${deleteForeverId}?force=true`, {
      method: "DELETE",
    });
    deleteForeverId = null;
    if (res.ok || res.status === 204) await invalidateAll();
  }

  // GameEditDialog onSave handler. Sends title + description to PATCH
  // /api/games/:id; on success the loader is invalidated so the new values
  // appear immediately. Throws on non-OK responses so the dialog's
  // pending/error state surfaces.
  async function saveGameEdits(payload: {
    title: string;
    description: string | null;
  }): Promise<void> {
    const res = await fetch(`/api/games/${game.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let code = "error_server_generic";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) code = body.error;
      } catch {
        /* ignore body parse */
      }
      throw new Error(code);
    }
    await invalidateAll();
    editGameOpen = false;
  }

  // Notes editor modal — extracted to NotesEditorModal component which
  // owns the dialog markup, draft state, Save/Cancel buttons and
  // Cmd/Ctrl+Enter shortcut (audit DRY-extract finding). This page owns
  // the open flag + the PATCH call.
  let notesEditorOpen = $state(false);
  let notesError = $state<string | null>(null);
  function openNotesEditor(): void {
    notesError = null;
    notesEditorOpen = true;
  }
  async function commitNotes(value: string): Promise<void> {
    notesError = null;
    try {
      const res = await fetch(`/api/games/${game.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: value }),
      });
      if (!res.ok) {
        notesError = "error_server_generic";
        return;
      }
      notesEditorOpen = false;
      await invalidateAll();
    } catch {
      notesError = "error_network";
    }
  }

  // Soft-delete game — moved from /games list to here per UAT.
  // Pulled into ⋮ overflow next to PageHeader so it stays reachable
  // without scrolling past N events.
  let deleteConfirmOpen = $state(false);
  let gameMenuOpen = $state(false);
  async function deleteGame(): Promise<void> {
    const res = await fetch(`/api/games/${game.id}`, { method: "DELETE" });
    deleteConfirmOpen = false;
    if (res.ok || res.status === 204) await goto("/games");
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/games">Games</a>
  <span aria-hidden="true">/</span>
  <span>{game.title}</span>
</nav>

{#if trashView}
  <!-- Trash view — the game's soft-deleted listings as read-only cards
       with Restore + Delete forever (mirrors /games?view=trash). -->
  <header class="game-header">
    <h1 class="game-title">{m.steam_listing_trash_heading()}</h1>
  </header>

  <div class="trash-banner" role="status">
    <a class="trash-back" href="/games/{game.id}">← {m.steam_listing_trash_back()}</a>
    <span class="trash-banner-text">{m.games_trash_banner_text({ days: data.retentionDays })}</span>
  </div>

  {#if deletedListings.length === 0}
    <div class="trash-empty" role="status">
      <p class="trash-empty-body">{m.steam_listing_trash_empty()}</p>
      <a href="/games/{game.id}" class="trash-back-link">{m.steam_listing_trash_back()}</a>
    </div>
  {:else}
    <ul class="stores-grid">
      {#each deletedListings as l (l.id)}
        <li>
          <SteamListingRow
            listing={l}
            trash
            onRestore={() => restoreListing(l.id)}
            onDeleteForever={() => askDeleteForever(l.id)}
          />
        </li>
      {/each}
    </ul>
  {/if}

  <ConfirmDialog
    open={confirmDeleteForeverOpen}
    message={m.steam_listing_confirm_delete_forever_title() +
      " " +
      m.steam_listing_confirm_delete_forever_body()}
    confirmLabel={m.steam_listing_delete_forever_cta()}
    onConfirm={confirmDeleteForever}
    onCancel={() => (confirmDeleteForeverOpen = false)}
  />
{:else}
  <!--
  PageHeader.cta opens <GameEditDialog>.
-->
  <!-- Inline title row with Edit + ⋮ side by side so Delete is
     discoverable right next to the title, not buried below. -->
  <header class="game-header">
    <h1 class="game-title">{game.title}</h1>
    <button type="button" class="btn-edit" onclick={() => (editGameOpen = true)}>
      {m.games_detail_edit_cta()}
    </button>
    <div class="game-overflow-wrap">
      <button
        type="button"
        class="game-overflow-btn"
        onclick={() => (gameMenuOpen = !gameMenuOpen)}
        aria-haspopup="menu"
        aria-expanded={gameMenuOpen}
        aria-label="More actions"
        title="More actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {#if gameMenuOpen}
        <button
          type="button"
          class="game-overflow-scrim"
          onclick={() => (gameMenuOpen = false)}
          aria-label="Close menu"
        ></button>
        <div class="game-overflow-pop" role="menu">
          <button
            type="button"
            class="card-menu-item danger"
            role="menuitem"
            onclick={() => {
              gameMenuOpen = false;
              deleteConfirmOpen = true;
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
            </svg>
            <span>Delete game</span>
          </button>
        </div>
      {/if}
    </div>
    {#if deletedListings.length > 0}
      <a class="recovery-link" href="/games/{game.id}?view=trash">
        {m.steam_listing_recently_deleted_link({ count: deletedListings.length })}
      </a>
    {/if}
  </header>

  <!--
  GameEditDialog modal — title input + description textarea +
  Save / Cancel. Always mounted (the dialog itself defends against the
  closed state via the .dialog[open] CSS scoping); the parent owns the
  open prop.
-->
  <GameEditDialog
    open={editGameOpen}
    initialTitle={game.title}
    initialDescription={game.description}
    onClose={() => (editGameOpen = false)}
    onSave={saveGameEdits}
  />

  <!--
  AddStoreDialog modal — wraps the existing AddSteamListingForm. Always
  mounted (the dialog defends the closed state via .dialog[open] CSS
  scoping); the parent owns the open prop. Opened by the Add CTA next
  to the Stores h2 (below).
-->
  <AddStoreDialog
    open={addStoreOpen}
    gameId={game.id}
    onClose={() => (addStoreOpen = false)}
    onSuccess={() => {
      addStoreOpen = false;
      void invalidateAll();
    }}
  />

  <!--
  Description paragraph renders after the meta row when game.description
  is non-null. `white-space: pre-wrap` preserves newlines typed in the
  textarea.
-->
  <section class="game-info" id="section-game">
    <!-- Meta row carries only release date now. Per-game tags (Steam
       genres/categories) + notes (legacy free-form field) removed —
       neither was user-editable via GameEditDialog, and tags duplicated
       per-store badges that live inside each SteamListingRow. User UAT:
       «теги убираем и второе описание которое я не делал и которое я
       не могу редактировать тоже убираем». -->
    {#if game.releaseTba || game.releaseDate}
      <div class="meta">
        {#if game.releaseTba}
          <span class="badge">{m.badge_release_tba()}</span>
        {:else if game.releaseDate}
          <span class="badge">{game.releaseDate}</span>
        {/if}
      </div>
    {/if}
    {#if game.description}
      <p class="description">{game.description}</p>
    {/if}

    <!-- Notes section — free-form private remarks, edited via a modal
       (same vocabulary as event notes-editor-modal). Click the section
       (text or empty-state button) → opens big editor. -->
    <div class="notes-section">
      <div class="notes-head">
        <span class="notes-label">Notes</span>
        <button
          type="button"
          class="notes-edit-btn"
          onclick={openNotesEditor}
          aria-label="Edit notes"
          title="Edit notes"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      </div>
      {#if game.notes}
        <p class="notes">{game.notes}</p>
      {:else}
        <button type="button" class="notes-empty" onclick={openNotesEditor}> + Add notes </button>
      {/if}
    </div>
  </section>

  <!--
  Add CTA next to the Stores h2. Click opens <AddStoreDialog>.
  StoresSection is a pure list renderer.
-->
  <section class="stores" id="section-stores">
    <header class="section-header">
      <h2>{m.games_detail_section_stores()}</h2>
      <button
        type="button"
        class="cta-secondary add-store-cta"
        onclick={() => (addStoreOpen = true)}
      >
        + {m.stores_add_cta()}
      </button>
    </header>
    <StoresSection
      {listings}
      gameId={game.id}
      wishlistSummaries={data.wishlistSummaries}
      onChange={() => invalidateAll()}
    />
  </section>

  <!--
  VIZ-02 == VIZ-03 (D-12): the headline wishlist-correlation chart. ONE
  component — the wishlist daily line + kind-colored event markers; a marker
  click opens the page-owned centered EventDayModal. Between Stores and Events.
-->
  <section class="correlation" id="section-correlation">
    <header class="section-header">
      <h2>{m.viz_wishlist_line_label()}</h2>
    </header>

    <!-- ONE date-range control for BOTH charts (04-10): the feed's preset
         picker (DateRangeRow) — All time / Year / Month / Week / Today + a
         custom range — with the sort toggle hidden (the chart has no sort
         axis). The selected preset resolves to the {from,to} window the charts
         consume. The per-listing legend is a custom <ChartLegend> below this
         row (04-09): it flips `chartVisible`, which both charts filter by. -->
    <DateRangeRow
      dateRange={chartDateRange}
      onDateRangeChange={(n) => (chartDateRange = n)}
      showSort={false}
      today={chartTodayDate}
    />

    <!-- Custom on-brand per-listing legend (04-09) — ONE control for BOTH
         charts. Pill chips matching the site .chip vocabulary; click toggles a
         listing's line + bar via the page-owned `chartVisible` map. -->
    {#if legendListings.length > 0}
      <ChartLegend listings={legendListings} visible={chartVisible} onToggle={toggleListing} />
    {/if}

    <WishlistCorrelationChart
      seriesByListing={chartSeriesByListing}
      events={chartEvents}
      listings={chartListings}
      today={data.today}
      range={chartRange}
      visible={chartVisible}
      onSelectCluster={(days) => (selectedChartDays = days)}
    />

    <!-- Second wishlist chart (04-08): DAILY net change (prior day's cumulative
         balance subtracted from today's) as bars per visible listing, sharing
         the SAME range + legend + event markers as the line chart above. -->
    <div class="growth-block">
      <h3 class="growth-heading">{m.viz_growth_title()}</h3>
      <WishlistGrowthChart
        seriesByListing={chartSeriesByListing}
        events={chartEvents}
        listings={chartListings}
        today={data.today}
        range={chartRange}
        visible={chartVisible}
        onSelectDay={(d) => (selectedChartDays = [d])}
      />
    </div>
  </section>

  <!-- Day-detail modal (04-10) — a CENTERED modal owned by the page (it has the
       feed data). A marker click on either chart sets selectedChartDay; the
       modal shows that day's stats header + FeedCard rows. Replaces the old
       per-chart EventMarkerPanel side drawer. -->
  <EventDayModal
    open={selectedChartDays.length > 0}
    days={selectedChartDays}
    events={selectedDayEvents}
    delta={selectedDayDelta}
    {sourceById}
    {gameById}
    games={allGames}
    onClose={() => (selectedChartDays = [])}
  />

  <section class="events" id="section-events">
    <header class="section-header">
      <h2>{m.games_detail_section_events()}</h2>
      <a class="cta-secondary" href={`/events/new?gameId=${game.id}`}>
        + {m.feed_cta_add_event()}
      </a>
    </header>

    {#if events.length === 0}
      <EmptyState
        heading={m.games_detail_events_empty()}
        body={m.games_detail_events_empty_body()}
      />
    {:else if feedEvents.length === 0}
      <!-- The game HAS events, but the chart's date range hid all of them. -->
      <EmptyState
        heading={m.games_detail_events_empty()}
        body={m.games_detail_events_empty_body()}
      />
    {:else}
      <div class="feedcard-grid">
        {#each groupedEvents as group (group.date)}
          <FeedDateGroupHeader occurredAt={group.occurredAt} count={group.rows.length} />
          {#each group.rows as ev (ev.id)}
            <FeedCard
              event={ev}
              source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
              game={ev.gameIds.length > 0 ? (gameById.get(ev.gameIds[0]!) ?? null) : null}
              games={allGames}
            />
          {/each}
        {/each}
      </div>
    {/if}
  </section>

  <!-- Bottom danger-zone removed — Delete game lives in the ⋮ overflow
     next to PageHeader, reachable without scrolling past N events. -->

  <ConfirmDialog
    open={deleteConfirmOpen}
    message={m.confirm_game_delete({ title: game.title })}
    confirmLabel={m.common_delete()}
    onConfirm={deleteGame}
    onCancel={() => (deleteConfirmOpen = false)}
  />

  <!-- Notes editor modal — shared NotesEditorModal owns dialog markup,
     draft state, Save/Cancel buttons, Cmd/Ctrl+Enter, Esc / backdrop
     cancel and the disabled-while-saving state. The page owns only the
     open flag, initial value pluck from `game.notes`, and the PATCH. -->
  <NotesEditorModal
    open={notesEditorOpen}
    initialValue={game.notes ?? ""}
    title="Notes"
    placeholder="Anything worth remembering about this game…"
    onSave={(value) => commitNotes(value)}
    onCancel={() => (notesEditorOpen = false)}
  />
  {#if notesError}
    <InlineError message={notesError} />
  {/if}
{/if}

<style>
  .breadcrumb {
    display: flex;
    gap: var(--s-1);
    color: var(--text-3);
    font-size: var(--t-13);
    margin-bottom: var(--s-4);
  }
  .breadcrumb a {
    color: var(--accent);
    text-decoration: none;
  }
  /* Stores + Events both render their CTA in the section-header row
   * (h2 + button/link). Stores' Add CTA opens AddStoreDialog modal;
   * Events' "+ New event" stays a navigation link to /events/new. */
  .section-header {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    margin-bottom: var(--s-4);
    flex-wrap: wrap;
  }
  .section-header h2 {
    margin: 0;
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    color: var(--text);
  }
  .game-info {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: 0;
    margin-bottom: var(--s-6);
    min-width: 0;
  }
  .stores {
    margin-bottom: var(--s-6);
    min-width: 0;
  }
  .correlation {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    margin-bottom: var(--s-6);
    min-width: 0;
  }
  .growth-block {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .growth-heading {
    margin: 0;
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    color: var(--text-2);
    line-height: var(--lh-tight);
  }
  .events {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    margin-top: var(--s-6);
    min-width: 0;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .badge,
  .chip {
    font-size: var(--t-12);
    color: var(--text-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 2px var(--s-2);
  }
  /* Description paragraph in the game-info section. */
  .description {
    margin: 0;
    color: var(--text);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .notes {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Notes section header row + editable affordance. */
  .notes-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: var(--s-3);
    padding-top: var(--s-3);
    border-top: 1px solid var(--border-hairline);
  }
  .notes-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .notes-label {
    font-size: 10.5px;
    font-weight: var(--w-sb);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .notes-edit-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    transition:
      background var(--m-fast),
      color var(--m-fast),
      border-color var(--m-fast);
  }
  .notes-edit-btn:hover {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }
  .notes-empty {
    align-self: flex-start;
    padding: 4px 10px;
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--accent) 50%, var(--border));
    border-radius: var(--r-pill);
    color: var(--accent);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    font-family: inherit;
  }
  .notes-empty:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }

  /* Inline header — title + Edit + ⋮ + recovery link, all in one row.
   * Replaces the separate PageHeader + game-overflow-row that split
   * them visually (user couldn't find ⋯ separated from the title). */
  .game-header {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
    margin-bottom: var(--s-4);
  }
  .game-title {
    margin: 0;
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
  }
  .btn-edit {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast);
  }
  .btn-edit:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .recovery-link {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    font-size: var(--t-13);
    color: var(--text-3);
    text-decoration: underline;
    margin-left: auto;
  }
  .recovery-link:hover {
    color: var(--accent);
  }

  /* ── Trash view (?view=trash) — mirrors /games trash-banner pattern. ── */
  .trash-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    margin-bottom: var(--s-4);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
  }
  .trash-back {
    color: var(--accent-strong);
    text-decoration: none;
    font-weight: var(--w-sb);
    white-space: nowrap;
  }
  .trash-back:hover {
    text-decoration: underline;
  }
  .trash-banner-text {
    color: var(--accent);
  }
  .trash-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-8) var(--s-4);
  }
  .trash-empty-body {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-14);
    line-height: var(--lh-body);
  }
  .trash-back-link {
    color: var(--accent);
    text-decoration: underline;
    font-size: var(--t-14);
    font-weight: var(--w-sb);
  }
  .trash-back-link:hover {
    color: var(--accent-strong);
  }
  /* Trash card grid — same shape as StoresSection's grid so the deleted
   * listings read as the same card vocabulary as the active stores. */
  .stores-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--s-3);
  }
  .game-overflow-wrap {
    position: relative;
  }
  .game-overflow-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-2);
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast);
  }
  .game-overflow-btn:hover,
  .game-overflow-btn[aria-expanded="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  .game-overflow-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .game-overflow-pop {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex;
    flex-direction: column;
    z-index: 50;
  }
  .game-overflow-pop .card-menu-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: transparent;
    border: 0;
    text-align: left;
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
    font-family: inherit;
  }
  .game-overflow-pop .card-menu-item:hover {
    background: var(--accent-soft);
  }
  .game-overflow-pop .card-menu-item.danger {
    color: var(--danger);
  }
  .game-overflow-pop .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
  }

  /* Notes editor modal markup + styles live in NotesEditorModal.svelte
   * (DRY-extract per audit). The component carries its own .notes-editor-*
   * style block; this file no longer needs the duplicated CSS. */
  /* v2 feed grid mirrors /feed/+page.svelte: single column <640px,
   * minmax(320px, 1fr) ≥640px, 3-column cap at --max-w.
   *
   * FeedDateGroupHeader must span all columns (`grid-column: 1 / -1`) so
   * the date heading reads as a row separator above the card row instead
   * of landing in the first grid track and pushing the card to the right.
   * Mirrors the /feed orchestrator behavior: there each date group lives
   * in its own .feed-grid block, so date headers are siblings to the
   * grid — here both are inside the same grid because the page does not
   * partition by date. */
  .feedcard-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-4);
    min-width: 0;
  }
  .feedcard-grid :global(.date-head) {
    grid-column: 1 / -1;
  }
  @media (min-width: 640px) {
    .feedcard-grid {
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
  }
  @media (min-width: 1280px) {
    .feedcard-grid {
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      max-width: var(--max-w);
    }
  }
  /* Section-header "+ Add" / "+ New event" CTA — ghost-styled to match
   * prototype `.btn.add-event` and the shared <PageHeader> CTA so the
   * Stores + Events section affordances read as the same vocabulary as
   * the page-level title CTA. The accent ring + accent text variant was
   * heavier than the prototype intends. */
  .cta-secondary {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta-secondary::first-letter {
    color: var(--accent);
    font-size: 1.1em;
    font-weight: var(--w-sb);
  }
  .cta-secondary:hover {
    background: var(--surface-3, var(--surface-2));
    border-color: var(--accent);
    color: var(--text);
  }
  .cta-secondary:hover::first-letter {
    color: var(--accent-strong);
  }
  /* The Add Store CTA in the stores section-header matches the Events
   * "+ New event" CTA visually so the two section headers read as a
   * consistent pattern. */
  .add-store-cta {
    cursor: pointer;
    font-family: inherit;
  }
  @media (prefers-reduced-motion: reduce) {
    .cta-secondary {
      transition: none;
    }
  }
</style>

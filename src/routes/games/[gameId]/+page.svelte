<script lang="ts">
  // /games/[gameId] — detail view (Plan 02.1-30 redesign; Plan 02.1-39
  // round-6 three-section restructure).
  //
  // Plan 02.1-30 RETIRED the Plan 02.1-25 oversized 2-card layout per
  // UAT-NOTES.md §4.25.B. Plan 02.1-39 (UAT-NOTES.md §5.3) takes the next
  // step: the page now renders THREE labelled sections — Игра / Магазины /
  // Лента — with each section's Edit / Add CTA collocated next to its
  // <h2> in a `.section-header` row. Round-5 user quote (verbatim, ru):
  // "По сути получается тут 3 части. Игра(название, описание, моя иконка)
  // Сторы(карточки, 3 в ряд как в feed) Feed. Тоже 3 в ряд как в feed".
  //
  // New structure (top → bottom):
  //   0. <PageHeader title={game.title} sticky /> — sticky title row under
  //      AppHeader matches /feed, /games, /audit (Plan 02.1-39 §5.7).
  //   1. <section class="game-info"> — section-header (h2 "Игра" + Edit
  //      toggle) → GameCover + RenameInline + meta + notes.
  //   2. <section class="stores"> — section-header (h2 "Магазины" + Edit
  //      toggle + + Add CTA) → StoresSection (now a 3-per-row grid at
  //      ≥900px, single column at 360px).
  //   3. <section class="events"> — section-header (h2 "Лента" + + New
  //      event link) → FeedCard list in a `.feedcard-grid` (3-per-row at
  //      ≥900px, single column at <640px). /feed stays one-card-per-row
  //      vertical (intentional per UAT-NOTES.md §5.3 'item D').
  //
  // Plan 02.1-39 (§5.3 item E): the global page-level `editMode` from Plan
  // 02.1-30 is split into TWO scoped toggles — `editingGame` (drives the
  // game-info section's edit affordances; reserved for future fields like
  // description / icon Phase 6) and `editingStores` (drives the
  // SteamListingRow Remove × buttons inside StoresSection). Each section's
  // edit toggle is independent so users can edit one section without
  // accidentally enabling the other's destructive affordances.
  //
  // Item B (games.description + games.icon_url + upload pipeline) is
  // EXPLICITLY DEFERRED to Phase 6 polish backlog per UAT-NOTES.md §5.3 —
  // requires schema changes + upload infra, not a 2.1 round-6 deliverable.
  // The .game-info section's Edit toggle today reuses the existing
  // RenameInline component; future Phase 6 work will hang description /
  // icon UI off the same `editingGame` toggle.
  //
  // Privacy invariants preserved:
  //   - Loader uses tenant-scoped service calls (listEventsForGame +
  //     mapEventsToDtos — Plan 02.1-28).
  //   - DELETE /api/games/:gameId/listings/:listingId uses cross-tenant
  //     404 (Plan 02-08 + Plan 02.1-29).
  //   - AddSteamListingForm duplicate-toast surfaces existingGameId, but
  //     the lookup is userId-scoped so cross-tenant existingGameId never
  //     leaks (Plan 02.1-29 service hardening).

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import RenameInline from "$lib/components/RenameInline.svelte";
  import StoresSection from "$lib/components/StoresSection.svelte";
  import GameCover from "$lib/components/GameCover.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  // Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12,
  // 2026-04-30): RecoveryDialog extends to per-game soft-deleted listings.
  // User during round-6 UAT after the polish #11 parity sweep landed
  // (verbatim, ru): "и я удалил стор, и теперь нет вохзможности его
  // восстановить" ("and I deleted a store, and now there's no way to
  // restore it"). The data layer was already there (Plan 02.1-04 added
  // `deleted_at` to `game_steam_listings`); only the recovery UI was
  // missing. Mounts the same RecoveryDialog the parity sweep wired into
  // /feed, /games, /sources — entityType="store" is the new discriminator.
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";
  import type { GameSteamListingDto } from "$lib/server/dto.js";
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
    // Plan 02.1-28 (M:N migration): the legacy singular gameId is REPLACED
    // with gameIds[] from the event_games junction. Cards on /games/[id]
    // always have at least one attached game (the current one), so the
    // inline 'Mark standalone' affordance HIDES automatically via the
    // FeedCard isInboxRow gate.
    gameIds: string[];
    sourceId: string | null;
    authorIsMe: boolean;
    metadata: unknown;
    lastPolledAt: Date | string | null;
    externalId: string | null;
    notes: string | null;
  };

  // Plan 02.1-30: align listings type with the GameSteamListingDto produced
  // by the loader's `listings.map(toGameSteamListingDto)`. StoresSection +
  // SteamListingRow expect the full DTO shape.
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

  // Plan 02.1-39 round-6 polish #12: PageData carries the new
  // `deletedListings: GameSteamListingDto[]` payload alongside the active
  // listings. `retentionDays` flows from the root +layout.server.ts so
  // RecoveryDialog renders the per-row purge countdown via RetentionBadge.
  let { data }: { data: PageData & { retentionDays: number } } = $props();

  const game = $derived(data.game);
  const listings = $derived(data.listings as ListingDto[]);
  const deletedListings = $derived(data.deletedListings as ListingDto[]);
  const events = $derived(data.events as EventDtoLocal[]);
  const allGames = $derived(data.games as GameLite[]);
  const sources = $derived(data.sources as SourceLite[]);

  // Source-id → SourceLite map for FeedCard's source chip resolution.
  const sourceById = $derived.by(() => {
    const map = new Map<string, SourceLite>();
    for (const s of sources) map.set(s.id, s);
    return map;
  });

  // Game-id → GameLite map for FeedCard's primary game chip resolution.
  // Plan 02.1-28: events on /games/[id] can be attached to multiple games
  // (M:N junction); FeedCard renders gameIds[0] as the primary chip per
  // round-3 UAT continuity (Plan 02.1-32 swaps for full chip-set render).
  const gameById = $derived(new Map(allGames.map((g) => [g.id, g])));

  // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  // 2026-04-30): the section-level edit toggles from §5.3 item E are
  // RETIRED in favor of per-affordance edit surfaces. User during round-6
  // UAT (verbatim, ru):
  //   - "Заголовок game не нужно. Вот есть название. Справа от него edit."
  //     ("The 'Game' heading isn't needed. We already have the title.
  //      Edit is to the right of it.")
  //   - "кнопка edit она у каждой карточки стора, мелко и отдельно"
  //     ("the Edit button is on each store card, small and separate")
  //
  // The single `editingGame` toggle (which never gated anything beyond
  // RenameInline's already-always-on inline edit affordance) is replaced
  // by passing PageHeader an Edit CTA next to the title — toggling the
  // EXISTING `gameInfoEditing` state which simply expands an "editing
  // hint" today and is the future surface for description / icon UI.
  //
  // The `editingStores` global toggle is RETIRED — each SteamListingRow
  // owns its own local edit-mode now, revealed by a per-card Edit button.
  // The StoresSection no longer needs an aggregate edit toggle from the
  // parent page; its old `editMode` prop becomes dead weight (kept on
  // the prop API for now to avoid a churn in test surfaces, defaulted to
  // false). Per-card Remove × visibility is gated by the card's own
  // edit-mode state.
  let gameInfoEditing = $state(false);

  // Plan 02.1-30 (UAT-NOTES.md §4.25.B): group events by date using the
  // SAME groupEventsByDate utility /feed uses (Plan 02.1-19). The events
  // feed on /games/[id] reads exactly like /feed minus the filter chrome.
  const groupedEvents = $derived(groupEventsByDate(events));

  // Plan 02.1-39 round-6 polish #12: RecoveryDialog open state. Same
  // contract as /feed, /games, /sources: opened by PageHeader's "Recently
  // deleted (N)" button; closed by Escape, backdrop click, dialog × button,
  // or auto-closes when the last recoverable item is restored.
  let recoveryOpen = $state(false);

  // Map deletedListings into the dialog's generic { id, name, deletedAt }
  // shape. `name` may be NULL when the Steam appdetails fetch failed at
  // INSERT time; fall back to `App {appId}` so every row has a recognizable
  // label (mirror of SteamListingRow's displayName fallback).
  const recoveryItems = $derived(
    deletedListings.map((l) => ({
      id: l.id,
      name: l.name ?? `App ${l.appId}`,
      deletedAt: l.deletedAt,
    })),
  );

  async function restoreListingFn(listingId: string): Promise<void> {
    const res = await fetch(
      `/api/games/${game.id}/listings/${listingId}/restore`,
      { method: "POST" },
    );
    if (res.ok || res.status === 200) {
      await invalidateAll();
      // If that was the last recoverable item, close the dialog so the
      // user is not stuck staring at "Nothing to recover" (the parent
      // also stops rendering the PageHeader CTA at the same time —
      // deletedCount falls to 0). Same pattern as the parity sweep on
      // /feed, /games, /sources.
      if (deletedListings.length <= 1) recoveryOpen = false;
    }
  }

  // -- Rename: PATCH /api/games/:id { title } --
  let renameError = $state<string | null>(null);
  async function saveRename(title: string): Promise<void> {
    renameError = null;
    const res = await fetch(`/api/games/${game.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      let code = "error_server_generic";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) code = body.error;
      } catch {
        /* ignore */
      }
      renameError = code;
      throw new Error(code);
    }
    await invalidateAll();
  }
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/games">Games</a>
  <span aria-hidden="true">/</span>
  <span>{game.title}</span>
</nav>

<!--
  Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  2026-04-30): PageHeader's `cta` prop carries the game's Edit toggle
  next to the title, replacing the §5.3-era "Game" section <h2> + Edit
  button row. User direction (verbatim, ru): "Заголовок game не нужно.
  Вот есть название. Справа от него edit."
-->
<PageHeader
  title={game.title}
  cta={{
    onClick: () => {
      gameInfoEditing = !gameInfoEditing;
    },
    label: gameInfoEditing ? m.common_close() : m.games_detail_edit_cta(),
  }}
  sticky
  deletedCount={deletedListings.length}
  onOpenRecovery={() => (recoveryOpen = true)}
/>

<!--
  Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12,
  2026-04-30): RecoveryDialog for soft-deleted Steam listings. Mounts
  only when deletedListings.length > 0 (the dialog itself defends
  against the empty case too — defense-in-depth).
-->
{#if deletedListings.length > 0}
  <RecoveryDialog
    open={recoveryOpen}
    items={recoveryItems}
    entityType="store"
    retentionDays={data.retentionDays}
    onClose={() => (recoveryOpen = false)}
    onRestore={restoreListingFn}
  />
{/if}

<!--
  Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  2026-04-30): three labelled sections REDUCE to two visible section
  headers — "Game" h2 is REMOVED because the page title in PageHeader
  already identifies the game. Edit affordance for the game moves up
  to PageHeader's cta slot (above). Stores section keeps its <h2> per
  user direction; the Add CTA migrates to the BOTTOM of the section
  (after cards) — owned by StoresSection now. Per-section editingStores
  toggle is RETIRED; per-card Edit lives inside SteamListingRow.
-->
<section class="game-info" id="section-game">
  <GameCover title={game.title} listings={listings} />
  <RenameInline initial={game.title} onSave={saveRename} />
  {#if renameError}<InlineError message={m.error_server_generic()} />{/if}
  <div class="meta">
    {#if game.releaseTba}
      <span class="badge">{m.badge_release_tba()}</span>
    {:else if game.releaseDate}
      <span class="badge">{game.releaseDate}</span>
    {/if}
    {#each game.tags as tag}
      <span class="chip">{tag}</span>
    {/each}
  </div>
  {#if game.notes}
    <p class="notes">{game.notes}</p>
  {/if}
  {#if gameInfoEditing}
    <p class="editing-hint">{m.common_edit()}…</p>
  {/if}
</section>

<section class="stores" id="section-stores">
  <header class="section-header">
    <h2>{m.games_detail_section_stores()}</h2>
  </header>
  <StoresSection
    {listings}
    gameId={game.id}
    onChange={() => invalidateAll()}
  />
</section>

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
      body={m.empty_feed_filtered_body()}
    />
  {:else}
    <div class="feedcard-grid">
      {#each groupedEvents as group (group.date)}
        <FeedDateGroupHeader occurredAt={group.occurredAt} />
        {#each group.rows as ev (ev.id)}
          <FeedCard
            event={ev}
            source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
            game={ev.gameIds.length > 0
              ? (gameById.get(ev.gameIds[0]!) ?? null)
              : null}
            games={allGames}
            onChanged={() => invalidateAll()}
          />
        {/each}
      {/each}
    </div>
  {/if}
</section>

<style>
  .breadcrumb {
    display: flex;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin-bottom: var(--space-md);
  }
  .breadcrumb a {
    color: var(--color-accent);
    text-decoration: none;
  }
  /* Plan 02.1-39 (UAT-NOTES.md §5.3 item C/E): every section's <h2> + its
   * CTA sit in one row at the top of the section.
   *
   * Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13):
   * the "Game" section <h2> + Edit toggle row was REMOVED — the page
   * title in PageHeader is the primary identifier, and the Edit CTA
   * moved up to PageHeader's cta slot. The `.section-header` rule now
   * applies only to Stores and Events sections, both of which still
   * carry an h2 (Stores keeps "Магазины"; Events keeps "Лента"). The
   * Stores section's CTA migrated to the BOTTOM (after cards) — owned
   * by StoresSection now — so the section-header here is heading-only. */
  .section-header {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    margin-bottom: var(--space-md);
    flex-wrap: wrap;
  }
  .section-header h2 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
  }
  /* Plan 02.1-39 round-6 polish #13: the Edit toggle moved up to
   * PageHeader's cta slot. Toggling sets `gameInfoEditing = true` and
   * surfaces a tiny "Edit…" hint below the game-info section so users
   * know edit mode is active. RenameInline already always-on edits
   * the title; description / icon UI hangs off the same toggle in a
   * future plan covering files/uploads. */
  .editing-hint {
    margin: 0;
    color: var(--color-accent);
    font-size: var(--font-size-label);
    font-style: italic;
  }
  .game-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: 0;
    margin-bottom: var(--space-lg);
    min-width: 0;
  }
  .stores {
    margin-bottom: var(--space-lg);
    min-width: 0;
  }
  .events {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    margin-top: var(--space-lg);
    min-width: 0;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .badge,
  .chip {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .notes {
    margin: 0;
    color: var(--color-text-muted);
    line-height: var(--line-height-body);
    white-space: pre-wrap;
  }
  /* Plan 02.1-39 (UAT-NOTES.md §5.3 item D): FeedCards lay out in a
   * 3-per-row grid at >=900px, falling back to single-column at <640px.
   * /feed page does NOT get this grid (intentional per UAT-NOTES.md §5.3
   * "item D"). The auto-fill min 280px matches /feed's grid step but the
   * /feed media-query forces single-column below 640px while keeping the
   * grid behavior; here we want the same. */
  .feedcard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-md);
  }
  @media (max-width: 639px) {
    .feedcard-grid {
      grid-template-columns: 1fr;
    }
  }
  .cta-secondary {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
  .cta-secondary:hover {
    background: var(--color-accent);
    color: var(--color-accent-text);
  }
</style>

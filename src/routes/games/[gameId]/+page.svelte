<script lang="ts">
  // /games/[gameId] — detail view (Plan 02.1-30 redesign).
  //
  // Plan 02.1-30 RETIRES the Plan 02.1-25 oversized 2-card layout (game-
  // header-card + events-feed-card panel cards) per UAT-NOTES.md §4.25.B
  // user quote: "Карточки слишком большие. Часть 1 — карточки игр, стим,
  // итч и т.д. Затем фид по игре, карточки как в feed ленте, небольшие,
  // без фильтров и выбора даты".
  //
  // New layout (top → bottom):
  //   1. Lean game-header section: GameCover + RenameInline + meta
  //      (releaseDate / tags / notes) + page-level Edit toggle. NO panel
  //      border / background / radius — the oversized card surface from
  //      Plan 02.1-25 is GONE.
  //   2. <StoresSection> — header 'Магазины / Stores' + + Add CTA +
  //      SteamListingRow list (with edit-mode-only Remove × buttons).
  //      Closes UAT-NOTES.md §4.25.C (Stores section refactor).
  //   3. Events feed — heading + + New event link + vertical FeedCard
  //      list grouped by date via the SAME groupEventsByDate utility as
  //      /feed (Plan 02.1-19). NO FilterChips / DateRangeControl /
  //      FiltersSheet — pure list per UAT-NOTES.md §4.25.B.
  //
  // FeedCard reuse on /games/[gameId] is identical to /feed: the same
  // component with no new variants. The inline 'Mark standalone' button
  // is gated by `isInboxRow` (gameIds.length === 0), so cards on this
  // page (gameIds.length > 0 by construction — they're attached to the
  // current game) HIDE that affordance automatically.
  //
  // Page-level edit-mode toggle (Plan 02.1-30, UAT-NOTES.md §4.25.H):
  // mirrors Plan 02.1-22's SourceRow pattern but at the PAGE level (one
  // toggle per page, not per row). When `editMode` is true, every
  // SteamListingRow in StoresSection shows its × Remove button.
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

  let { data }: { data: PageData } = $props();

  const game = $derived(data.game);
  const listings = $derived(data.listings as ListingDto[]);
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

  // Plan 02.1-30 (UAT-NOTES.md §4.25.H): page-level edit-mode toggle that
  // controls SteamListingRow Remove button visibility inside StoresSection.
  // Single toggle per page, not per row — mirrors Plan 02.1-22 SourceRow
  // pattern adapted to the /games/[id] surface.
  let editMode = $state(false);

  // Plan 02.1-30 (UAT-NOTES.md §4.25.B): group events by date using the
  // SAME groupEventsByDate utility /feed uses (Plan 02.1-19). The events
  // feed on /games/[id] reads exactly like /feed minus the filter chrome.
  const groupedEvents = $derived(groupEventsByDate(events));

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
  Plan 02.1-30 (UAT-NOTES.md §4.25.B): three-section vertical layout.
  Lean game header (no panel surface) → StoresSection → events feed.
  The Plan 02.1-25 oversized 2-card layout (game-header-card +
  events-feed-card panel cards) is RETIRED.
-->
<section class="game-header">
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
  <button
    type="button"
    class="edit-toggle"
    onclick={() => (editMode = !editMode)}
    aria-pressed={editMode}
  >
    {editMode ? m.common_close() : m.common_edit()}
  </button>
</section>

<StoresSection
  {listings}
  gameId={game.id}
  {editMode}
  onChange={() => invalidateAll()}
/>

<section class="events-feed">
  <header class="events-feed-head">
    <h2 class="events-heading">{m.games_detail_events_heading()}</h2>
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
  /* Plan 02.1-30 (UAT-NOTES.md §4.25.B): lean game header. NO panel border /
   * background / radius — the oversized .game-header-card from Plan
   * 02.1-25 is RETIRED. Section is a simple vertical flex column. */
  .game-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-md) 0;
    margin-bottom: var(--space-lg);
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
  /* Plan 02.1-30: page-level Edit toggle. Shape mirrors SourceRow's
   * .icon-btn but rendered at the page level controlling all
   * SteamListingRow Remove buttons via the editMode prop. */
  .edit-toggle {
    align-self: flex-start;
    min-height: 44px;
    padding: 0 var(--space-md);
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .edit-toggle[aria-pressed="true"] {
    background: var(--color-surface);
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  /* Plan 02.1-30: events feed section — simple vertical column matching
   * /feed's surface (no panel wrapper). FeedCard handles its own width. */
  .events-feed {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    margin-top: var(--space-lg);
    min-width: 0;
  }
  .events-feed-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .events-heading {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
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

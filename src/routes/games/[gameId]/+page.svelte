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

  import { invalidateAll } from "$app/navigation";
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
  import PageHeader from "$lib/components/PageHeader.svelte";
  import GameEditDialog from "$lib/components/GameEditDialog.svelte";
  import AddStoreDialog from "$lib/components/AddStoreDialog.svelte";
  // RecoveryDialog extends to per-game soft-deleted listings.
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

  const groupedEvents = $derived(groupEventsByDate(events));

  let recoveryOpen = $state(false);

  const recoveryItems = $derived(
    deletedListings.map((l) => ({
      id: l.id,
      name: l.name ?? `App ${l.appId}`,
      deletedAt: l.deletedAt,
    })),
  );

  async function restoreListingFn(listingId: string): Promise<void> {
    const res = await fetch(`/api/games/${game.id}/listings/${listingId}/restore`, {
      method: "POST",
    });
    if (res.ok || res.status === 200) {
      await invalidateAll();
      if (deletedListings.length <= 1) recoveryOpen = false;
    }
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
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/games">Games</a>
  <span aria-hidden="true">/</span>
  <span>{game.title}</span>
</nav>

<!--
  PageHeader.cta opens <GameEditDialog>.
-->
<PageHeader
  title={game.title}
  cta={{
    onClick: () => {
      editGameOpen = true;
    },
    label: m.games_detail_edit_cta(),
  }}
  deletedCount={deletedListings.length}
  onOpenRecovery={() => (recoveryOpen = true)}
/>

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
  Description paragraph renders after the meta row when game.description
  is non-null. `white-space: pre-wrap` preserves newlines typed in the
  textarea.
-->
<section class="game-info" id="section-game">
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
  {#if game.description}
    <p class="description">{game.description}</p>
  {/if}
  {#if game.notes}
    <p class="notes">{game.notes}</p>
  {/if}
</section>

<!--
  Add CTA next to the Stores h2. Click opens <AddStoreDialog>.
  StoresSection is a pure list renderer.
-->
<section class="stores" id="section-stores">
  <header class="section-header">
    <h2>{m.games_detail_section_stores()}</h2>
    <button type="button" class="cta-secondary add-store-cta" onclick={() => (addStoreOpen = true)}>
      + {m.stores_add_cta()}
    </button>
  </header>
  <StoresSection {listings} gameId={game.id} onChange={() => invalidateAll()} />
</section>

<section class="events" id="section-events">
  <header class="section-header">
    <h2>{m.games_detail_section_events()}</h2>
    <a class="cta-secondary" href={`/events/new?gameId=${game.id}`}>
      + {m.feed_cta_add_event()}
    </a>
  </header>

  {#if events.length === 0}
    <EmptyState heading={m.games_detail_events_empty()} body={m.empty_feed_filtered_body()} />
  {:else}
    <div class="feedcard-grid">
      {#each groupedEvents as group (group.date)}
        <FeedDateGroupHeader occurredAt={group.occurredAt} />
        {#each group.rows as ev (ev.id)}
          <FeedCard
            event={ev}
            source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
            game={ev.gameIds.length > 0 ? (gameById.get(ev.gameIds[0]!) ?? null) : null}
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
    color: var(--text-3);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    white-space: pre-wrap;
  }
  /* v2 feed grid mirrors /feed/+page.svelte: single column <640px,
   * minmax(320px, 1fr) ≥640px, 3-column cap at --max-w. */
  .feedcard-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-4);
    min-width: 0;
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
  .cta-secondary {
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--surface);
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta-secondary:hover {
    background: var(--accent);
    color: var(--accent-text);
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

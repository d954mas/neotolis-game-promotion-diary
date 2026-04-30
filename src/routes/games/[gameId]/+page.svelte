<script lang="ts">
  // /games/[gameId] — detail view (Plan 02.1-30 redesign; Plan 02.1-39
  // round-6 three-section restructure; round-6 polish #14b consolidation
  // of the title + description edit surfaces).
  //
  // Plan 02.1-39 round-6 polish #14b (UAT-NOTES.md §5.8 follow-up #14,
  // 2026-04-30). User during round-6 UAT after polish #13 (commit d05a962)
  // landed (verbatim, ru):
  //   - "я вижу заголовок. Возле которого кнопка edit. Я нажал но не могу
  //      менять этот заголовок."
  //     ("I see the title. Edit is next to it. I clicked it but I can't
  //      edit this title.")
  //   - "Потом я вижу крупный header он тут не нужен. Дальше я вижу
  //      Редактируемый загловок, он не нужен это дублирование."
  //     ("Then I see a large header, it's not needed here. Then I see an
  //      editable title, it's a duplicate.")
  //   - "Еще я хочу чтобы тут можно было сделать описание игры."
  //     ("I also want to be able to add a description for the game here.")
  //
  // Polish #13 left two title surfaces — PageHeader.title with a
  // non-functional Edit toggle that only flipped a `gameInfoEditing` hint,
  // AND the always-visible <RenameInline> h1 click-to-edit. Polish #14b
  // collapses to one title (PageHeader.title) and one edit affordance
  // (PageHeader.cta opens GameEditDialog). RenameInline + the
  // gameInfoEditing toggle + the "editing-hint" paragraph are removed.
  //
  // GameEditDialog provides title input + description textarea + Save /
  // Cancel — actually editable, not a hint toggle. On Save it PATCHes
  // /api/games/:id with both fields and invalidateAll() refreshes the
  // loader.
  //
  // The description (when set) renders in the .game-info section after
  // the meta row, with `white-space: pre-wrap` so newlines from the
  // textarea survive the round-trip. When NULL, nothing renders — the
  // empty state is invisible (the user can always click Edit to add one).
  //
  // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14):
  //   "сейчас добавление стора сделано полями на этой странице. Я хочу
  //    через кнопку add рядом с заголовкот Stores"
  //   ("right now adding a store is done with fields on the page. I
  //    want it via an Add button next to the Stores heading")
  //
  // Polish #13's bottom-of-section Add CTA is REVERTED — the CTA moves
  // back next to the Stores h2 in the section-header row, and clicking
  // it opens AddStoreDialog (a modal wrapping the existing
  // AddSteamListingForm) rather than expanding the form inline.
  // StoresSection becomes a pure list renderer; the page owns the Add
  // modal lifecycle.
  //
  // Privacy invariants preserved:
  //   - Loader uses tenant-scoped service calls (listEventsForGame +
  //     mapEventsToDtos — Plan 02.1-28).
  //   - DELETE /api/games/:gameId/listings/:listingId uses cross-tenant
  //     404 (Plan 02-08 + Plan 02.1-29).
  //   - PATCH /api/games/:id (now carrying description) uses the same
  //     tenant-scoped updateGame service — cross-tenant 404 invariant
  //     exercised in tests/integration/games.test.ts.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import StoresSection from "$lib/components/StoresSection.svelte";
  // Plan 02.1-39 round-6 polish #15: GameCover removed from this page.
  // User during UAT: "после названия игры идет огромная картинка, мне не
  // нравится. Она тут лишняя, она есть в карточки стора". The cover already
  // surfaces on each SteamListingRow (Plan 02.1-39 §5.3 item A), so
  // rendering it AGAIN at the top of /games/[gameId] is duplicate visual
  // weight. Component file kept in src/lib/components for future reuse on
  // /games list page or preview surfaces.
  import PageHeader from "$lib/components/PageHeader.svelte";
  import GameEditDialog from "$lib/components/GameEditDialog.svelte";
  import AddStoreDialog from "$lib/components/AddStoreDialog.svelte";
  // Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12,
  // 2026-04-30): RecoveryDialog extends to per-game soft-deleted listings.
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
    lastPolledAt: Date | string | null;
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

  // Plan 02.1-39 round-6 polish #14b: replaces `gameInfoEditing` toggle
  // (which only flipped a non-functional hint) with `editGameOpen` — the
  // open-state of the new <GameEditDialog>. PageHeader's cta opens it.
  let editGameOpen = $state(false);

  // Plan 02.1-39 round-6 polish #14c: open-state of the new
  // <AddStoreDialog> modal. The Add CTA next to the Stores h2 toggles
  // it; the dialog's onSuccess closes it + invalidateAll().
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
    const res = await fetch(
      `/api/games/${game.id}/listings/${listingId}/restore`,
      { method: "POST" },
    );
    if (res.ok || res.status === 200) {
      await invalidateAll();
      if (deletedListings.length <= 1) recoveryOpen = false;
    }
  }

  // Plan 02.1-39 round-6 polish #14b: GameEditDialog onSave handler.
  // Sends title + description to PATCH /api/games/:id; on success the
  // loader is invalidated so the new values appear immediately. Throws
  // on non-OK responses so the dialog's pending/error state surfaces.
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
  Plan 02.1-39 round-6 polish #14b: PageHeader.cta opens
  <GameEditDialog>. Replaces polish #13's hint-toggle which was the only
  affordance and didn't actually edit anything (the click-to-edit lived
  on the now-removed <RenameInline> h1).
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
  Plan 02.1-39 round-6 polish #14b: GameEditDialog modal — title input
  + description textarea + Save / Cancel. Always mounted (the dialog
  itself defends against the closed state via the .dialog[open] CSS
  scoping); the parent owns the open prop.
-->
<GameEditDialog
  open={editGameOpen}
  initialTitle={game.title}
  initialDescription={game.description}
  onClose={() => (editGameOpen = false)}
  onSave={saveGameEdits}
/>

<!--
  Plan 02.1-39 round-6 polish #14c: AddStoreDialog modal — wraps the
  existing AddSteamListingForm. Always mounted (the dialog defends
  the closed state via .dialog[open] CSS scoping); the parent owns
  the open prop. Opened by the Add CTA next to the Stores h2 (below).
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
  Plan 02.1-39 round-6 polish #14b: the .game-info section drops
  <RenameInline> (the duplicate h1) and adds a description paragraph
  rendered after the meta row when game.description is non-null.
  `white-space: pre-wrap` preserves newlines typed in the textarea.
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
  Plan 02.1-39 round-6 polish #14c: Add CTA back next to the Stores h2
  (reverts polish #13's bottom-of-section placement). Click opens
  <AddStoreDialog>. StoresSection becomes a pure list renderer.
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
  /* Plan 02.1-39 round-6 polish #14c: Stores + Events both render
   * their CTA in the section-header row (h2 + button/link). Stores'
   * Add CTA opens AddStoreDialog modal; Events' "+ New event" stays
   * a navigation link to /events/new. */
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
  /* Plan 02.1-39 round-6 polish #14b: description paragraph in the
   * game-info section. white-space: pre-wrap preserves newlines from
   * the textarea round-trip. Reads as primary copy (not muted) since
   * it's the user's own pitch — the .notes paragraph below stays
   * muted as the lighter "internal" notes surface. */
  .description {
    margin: 0;
    color: var(--color-text);
    line-height: var(--line-height-body);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .notes {
    margin: 0;
    color: var(--color-text-muted);
    line-height: var(--line-height-body);
    white-space: pre-wrap;
  }
  /* Plan 02.1-39 (UAT-NOTES.md §5.3 item D): FeedCards lay out in a
   * 3-per-row grid at >=900px, falling back to single-column at <640px. */
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
  /* Plan 02.1-39 round-6 polish #14c: the Add Store CTA in the
   * stores section-header matches the Events "+ New event" CTA
   * visually so the two section headers read as a consistent pattern.
   * Cursor: pointer because it's a <button> not an <a>. */
  .add-store-cta {
    cursor: pointer;
    font-family: inherit;
  }
</style>

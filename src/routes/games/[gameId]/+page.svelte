<script lang="ts">
  // /games/[gameId] — detail view (Phase 2.1 Plan 02.1-09 rebuild).
  //
  // Closes the Phase 2 P0 functional gap: rename via <RenameInline> +
  // add-Steam-listing via <AddSteamListingForm>. UI-SPEC §"/games/[id]
  // rebuild" pivots from the Phase 2 multi-panel layout to the
  // unified-events curated layout (header / store-listings / events).
  // The Phase 2 per-platform-channel panel and the per-game tracked-video
  // panel are GONE — the unified `events` table now carries kind
  // youtube_video rows attached to the game.
  //
  // Curated events panel: rows are grouped by month (<MonthHeader>) and
  // rendered with the same card component the /feed page uses (<FeedCard>,
  // Plan 02.1-16 replaces the prior <FeedRow>).
  // FeedCard handles its own ConfirmDialog on delete (UI polish-fix per
  // UI-SPEC §"Destructive confirmations") and its own AttachToGamePicker.
  //
  // No paste box on this page in 2.1 (UI-SPEC). Manual paste lives on
  // /feed where the user is already chronologically oriented; "+ New
  // event" links to /events/new for free-form entry.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import RenameInline from "$lib/components/RenameInline.svelte";
  import AddSteamListingForm from "$lib/components/AddSteamListingForm.svelte";
  import MonthHeader from "$lib/components/MonthHeader.svelte";
  // Plan 02.1-25 (UAT-NOTES.md §3.2-redesign): /games/[id] restructures into
  // two visually distinct panel cards — GAME HEADER CARD on top + EVENTS
  // FEED CARD below. <GameCover> renders the Steam header_image at the
  // top of the header card; <SteamListingRow> replaces the inline <li>
  // listings with a richer row that includes Steam name + Open-on-Steam link.
  import GameCover from "$lib/components/GameCover.svelte";
  import SteamListingRow from "$lib/components/SteamListingRow.svelte";
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
    // with gameIds[] from the event_games junction. The page renders the
    // first attached game as the primary chip for round-3 UAT continuity.
    gameIds: string[];
    sourceId: string | null;
    authorIsMe: boolean;
    metadata: unknown;
    lastPolledAt: Date | string | null;
    // Plan 02.1-16: FeedCard requires externalId for the YouTube thumbnail
    // URL. toEventDto already projects this field; the local type needs to
    // surface it so the props contract type-checks.
    externalId: string | null;
    // Plan 02.1-23: FeedCard renders a clipped notes paragraph below the
    // title. toEventDto already projects this field (events.notes column);
    // the local type needs to surface it so the props contract type-checks.
    notes: string | null;
  };

  type ListingDto = {
    id: string;
    appId: number;
    label: string;
    // Plan 02.1-25: persisted Steam name (Plan 02.1-25 column added in
    // drizzle/0004); SteamListingRow falls back to "App {appId}" when null
    // (legacy rows + Steam-down inserts).
    name: string | null;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
  };

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

  // Keep the page's <h1> rendered via FeedCard — single game lite for chip.
  const gameLite = $derived<GameLite>({ id: game.id, title: game.title });

  // -- Group curated events by month for <MonthHeader> --
  type Group = { key: string; label: string; rows: EventDtoLocal[] };
  const grouped = $derived.by((): Group[] => {
    const groups = new Map<string, Group>();
    for (const ev of events) {
      const occurred =
        ev.occurredAt instanceof Date ? ev.occurredAt : new Date(ev.occurredAt);
      const monthKey = `${occurred.getUTCFullYear()}-${String(
        occurred.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      const monthLabel = occurred.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
      });
      const existing = groups.get(monthKey);
      if (existing) {
        existing.rows.push(ev);
      } else {
        groups.set(monthKey, { key: monthKey, label: monthLabel, rows: [ev] });
      }
    }
    return [...groups.values()];
  });

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
  Plan 02.1-25 (UAT-NOTES.md §3.2-redesign): two-card layout.
  GAME HEADER CARD: cover + rename + metadata + Steam listings + add-listing.
  EVENTS FEED CARD: month-grouped FeedCards (existing).
  Both wrapped as panel cards (background, border, radius) so the visual
  separation is unmistakable on first scroll.
-->
<section class="game-header-card">
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

  <h2 class="listings-heading">Store listings</h2>
  {#if listings.length === 0}
    <p class="empty-inline">No Steam listings attached yet.</p>
  {:else}
    <ul class="listings">
      {#each listings as listing (listing.id)}
        <li>
          <SteamListingRow {listing} />
        </li>
      {/each}
    </ul>
  {/if}
  <AddSteamListingForm gameId={game.id} />
</section>

<section class="events-feed-card">
  <header class="panel-head">
    <h2>Events ({events.length})</h2>
    <a class="cta-small" href="/events/new">{m.feed_cta_add_event()}</a>
  </header>

  {#if events.length === 0}
    <EmptyState
      heading={m.empty_feed_filtered_heading()}
      body="Attach events from the /feed page to surface them here, or add a free-form event."
    />
  {:else}
    {#each grouped as group (group.key)}
      <MonthHeader month={group.label} count={group.rows.length} />
      <ul class="rows">
        {#each group.rows as ev (ev.id)}
          <li>
            <FeedCard
              event={ev}
              source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
              game={gameLite}
              games={allGames}
              onChanged={() => invalidateAll()}
            />
          </li>
        {/each}
      </ul>
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
  /* Plan 02.1-25 (UAT-NOTES.md §3.2-redesign): two panel cards stacked
   * vertically. Each card has the same surface styling so the visual
   * grouping is unambiguous on first scroll. The previous .panels grid
   * (2-col >= 1024px) is dropped — keeping them stacked makes the page
   * read top-down: artwork → metadata → listings → add-listing →
   * events feed. The grid layout encouraged horizontal scanning that
   * round-3 UAT explicitly rejected. */
  .game-header-card,
  .events-feed-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
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
  .listings-heading {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .events-feed-card h2 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
  }
  .empty-inline {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .listings {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .cta-small {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
</style>

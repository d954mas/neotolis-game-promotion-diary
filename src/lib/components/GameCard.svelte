<script lang="ts">
  // GameCard — list-row tile for /games. Title + cover + release badge +
  // event count + 2-line description excerpt. Soft-delete moved to the
  // /games/[gameId] detail surface per UAT — list view stays read-only.
  //
  // Color identification: --card-accent set inline from gameColor(id)
  // gives each row a deterministic hue stripe on the left, matching the
  // small game chips throughout the app (FeedCard, ActiveFiltersStrip,
  // EventDetailContent). Same hash function across surfaces.
  //
  // cover img: referrerpolicy="no-referrer" — Steam appdetails URLs
  // public but we don't leak origin to Steam's edge logs.

  import { m } from "$lib/paraglide/messages.js";
  import { gameColor } from "$lib/util/game-color.js";
  import RetentionBadge from "./RetentionBadge.svelte";

  type Game = {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    releaseTba: boolean;
    tags: string[];
    description: string | null;
    deletedAt: Date | string | null;
    eventCount?: number;
  };

  let {
    game,
    view = "feed",
    onRestore,
    onDeleteForever,
  }: {
    game: Game;
    /** "feed" (default) or "trash" — drives which affordances render. */
    view?: "feed" | "trash";
    onRestore?: () => void;
    onDeleteForever?: () => void;
  } = $props();

  const isTrash = $derived(view === "trash");
  let menuOpen = $state(false);
</script>

<!-- No opacity dimming for trash cards — matches /feed pattern where
     deleted events render at full readability. The trash-view banner +
     ⋮ menu actions (Restore / Delete forever) signal the deleted state. -->
<article class="card" style="--card-accent: {gameColor(game.id)};">
  {#if game.coverUrl}
    <img class="cover" src={game.coverUrl} alt="" referrerpolicy="no-referrer" loading="lazy" />
  {:else}
    <div class="cover placeholder" aria-hidden="true"></div>
  {/if}
  <div class="body">
    <h3 class="title">
      {#if isTrash}
        <span>{game.title}</span>
      {:else}
        <a href={`/games/${game.id}`}>{game.title}</a>
      {/if}
    </h3>
    <div class="meta">
      {#if isTrash && game.deletedAt}
        <RetentionBadge deletedAt={game.deletedAt} />
      {/if}
      {#if game.releaseTba || game.releaseDate}
        <span class="release-date" title="Release date">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>{game.releaseTba ? m.badge_release_tba() : game.releaseDate}</span>
        </span>
      {/if}
      {#if game.eventCount !== undefined && game.eventCount > 0}
        <span class="event-count"
          >{game.eventCount} {game.eventCount === 1 ? "event" : "events"}</span
        >
      {/if}
    </div>
    {#if game.description}
      <p class="description">{game.description}</p>
    {/if}
  </div>
  <!-- ⋮ overflow — Restore + Delete forever. Trash-only: the non-trash
       /games list has no card actions, so the ⋮ would open an empty menu.
       Render it only in trash view. -->
  {#if isTrash}
    <div class="card-actions">
      <button
        type="button"
        class="card-action-btn overflow"
        onclick={(e) => {
          e.stopPropagation();
          menuOpen = !menuOpen;
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="19" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {#if menuOpen}
        <button
          type="button"
          class="menu-scrim"
          onclick={() => (menuOpen = false)}
          aria-label="Close menu"
        ></button>
        <div class="card-menu" role="menu">
          {#if onRestore}
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                onRestore?.();
              }}
            >
              {m.common_restore()}
            </button>
          {/if}
          {#if onDeleteForever}
            <button
              type="button"
              role="menuitem"
              class="danger"
              onclick={() => {
                menuOpen = false;
                onDeleteForever?.();
              }}
            >
              {m.games_trash_delete_forever()}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</article>

<style>
  /* v2 GameCard — --surface card + --r-md radius + --shadow-card elevation;
   * 96px/128px cover thumb with --surface-2 placeholder. LB-9
   * `referrerpolicy="no-referrer"` preserved on cover <img>. */
  .card {
    position: relative;
    display: grid;
    grid-template-columns: 96px 1fr auto;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-card);
    align-items: start;
    min-width: 0;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .card:hover {
    border-color: color-mix(in oklab, var(--card-accent, var(--accent)) 50%, var(--border));
  }
  /* Game-color stripe on the left, matches FeedCard's kind-color
   * stripe pattern. 2px inset 1px so it rounds with the card corner. */
  .card::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 1px;
    bottom: 1px;
    width: 3px;
    background: var(--card-accent, var(--border-2));
    border-top-left-radius: calc(var(--r-md) - 1px);
    border-bottom-left-radius: calc(var(--r-md) - 1px);
  }
  .cover {
    width: 96px;
    height: 96px;
    object-fit: cover;
    border-radius: var(--r-sm);
    background: var(--surface-2);
  }
  .cover.placeholder {
    background: var(--surface-2);
    border: 1px dashed var(--border);
  }
  .body {
    min-width: 0;
  }
  .title {
    margin: 0 0 var(--s-2) 0;
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
  }
  .title a {
    color: var(--text);
    text-decoration: none;
  }
  .title a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  /* Inline meta items — plain text, no pill border so they read as
   * metadata (date, count) instead of taggable chips. User UAT: «дата
   * показывается как чип, что выглядело как какой-то тег». */
  .release-date,
  .event-count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .event-count {
    color: color-mix(in oklab, var(--card-accent) 60%, var(--text-2));
    font-weight: var(--w-sb);
  }
  /* 2-line description excerpt — same line-clamp pattern as FeedCard. */
  .description {
    margin: var(--s-2) 0 0;
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* ⋮ overflow — same pattern as FeedCard / SourceRow. Absolute
   * top-right so it doesn't interfere with the grid layout. */
  .card-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
  }
  .card-action-btn.overflow {
    width: 28px;
    height: 28px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--r-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast);
  }
  .card-action-btn.overflow:hover,
  .card-action-btn.overflow[aria-expanded="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  .menu-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
    z-index: 3;
  }
  .card-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 160px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: var(--s-1);
    display: flex;
    flex-direction: column;
    z-index: 4;
  }
  .card-menu [role="menuitem"] {
    background: transparent;
    border: none;
    text-align: left;
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
  }
  .card-menu [role="menuitem"]:hover {
    background: var(--accent-soft);
  }
  .card-menu .danger:hover {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface-2));
    border-color: var(--danger);
  }
  @media (min-width: 768px) {
    .card {
      grid-template-columns: 128px 1fr auto;
    }
    .cover {
      width: 128px;
      height: 128px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .restore,
    .card {
      transition: none;
    }
  }
</style>

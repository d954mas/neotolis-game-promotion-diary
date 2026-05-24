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
    onRestore,
  }: {
    game: Game;
    /** Delete affordance moved to /games/[gameId]. Prop intentionally
     *  removed; restore stays for the deleted-list rendering. */
    onRestore?: () => void;
  } = $props();

  const isDeleted = $derived(game.deletedAt !== null);
</script>

<article class="card" class:deleted={isDeleted} style="--card-accent: {gameColor(game.id)};">
  {#if game.coverUrl}
    <img class="cover" src={game.coverUrl} alt="" referrerpolicy="no-referrer" loading="lazy" />
  {:else}
    <div class="cover placeholder" aria-hidden="true"></div>
  {/if}
  <div class="body">
    <h3 class="title">
      <a href={`/games/${game.id}`}>{game.title}</a>
    </h3>
    <div class="meta">
      {#if game.releaseTba || game.releaseDate}
        <span class="badge release" title="Release date">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {game.releaseTba ? m.badge_release_tba() : game.releaseDate}
        </span>
      {/if}
      {#if game.eventCount !== undefined && game.eventCount > 0}
        <span class="badge event-count">{game.eventCount} {game.eventCount === 1 ? "event" : "events"}</span>
      {/if}
    </div>
    {#if game.description}
      <p class="description">{game.description}</p>
    {/if}
  </div>
  <div class="actions">
    {#if isDeleted && onRestore}
      <button type="button" class="restore" onclick={onRestore}>{m.common_restore()}</button>
    {/if}
  </div>
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
    align-items: center;
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
  .deleted {
    opacity: 0.6;
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
  .badge,
  .chip {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-0) var(--s-2);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .badge.release {
    color: var(--text-2);
  }
  .badge.event-count {
    color: var(--text);
    background: color-mix(in oklab, var(--card-accent) 14%, var(--surface));
    border-color: color-mix(in oklab, var(--card-accent) 40%, var(--border));
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
  .actions {
    display: flex;
    gap: var(--s-1);
  }
  .restore {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .restore:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
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

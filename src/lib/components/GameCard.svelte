<script lang="ts">
  // GameCard — list-row tile for /games. Title + optional cover thumb
  // (96px mobile / 128px desktop) + release date or TBA badge + tag chips
  // + soft-delete affordance.
  //
  // The cover image carries `referrerpolicy="no-referrer"` per UI-SPEC
  // §"Registry Safety" — Steam appdetails URLs are public but we don't
  // want to leak our origin to Steam's edge logs.

  import { m } from "$lib/paraglide/messages.js";

  type Game = {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    releaseTba: boolean;
    tags: string[];
    deletedAt: Date | string | null;
  };

  let {
    game,
    onSoftDelete,
    onRestore,
  }: {
    game: Game;
    onSoftDelete?: () => void;
    onRestore?: () => void;
  } = $props();

  const isDeleted = $derived(game.deletedAt !== null);
</script>

<article class="card" class:deleted={isDeleted}>
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
      {#if game.releaseTba}
        <span class="badge tba">{m.badge_release_tba()}</span>
      {:else if game.releaseDate}
        <span class="badge">{game.releaseDate}</span>
      {/if}
      {#each game.tags.slice(0, 5) as tag}
        <span class="chip">{tag}</span>
      {/each}
    </div>
  </div>
  <div class="actions">
    {#if isDeleted}
      {#if onRestore}
        <button type="button" class="restore" onclick={onRestore}>{m.common_restore()}</button>
      {/if}
    {:else if onSoftDelete}
      <button type="button" class="delete" onclick={onSoftDelete} aria-label={m.common_delete()}>
        ×
      </button>
    {/if}
  </div>
</article>

<style>
  /* v2 GameCard — --surface card + --r-md radius + --shadow-card elevation;
   * 96px/128px cover thumb with --surface-2 placeholder. LB-9
   * `referrerpolicy="no-referrer"` preserved on cover <img>. */
  .card {
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
  .actions {
    display: flex;
    gap: var(--s-1);
  }
  .delete {
    min-width: var(--hit);
    min-height: var(--hit);
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .delete:hover {
    background: var(--danger);
    color: #fff;
    border-color: var(--danger);
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
    .delete,
    .restore {
      transition: none;
    }
  }
</style>

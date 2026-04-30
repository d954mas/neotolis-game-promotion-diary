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
  .card {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    align-items: center;
  }
  .deleted {
    opacity: 0.6;
  }
  .cover {
    width: 96px;
    height: 96px;
    object-fit: cover;
    border-radius: 4px;
    background: var(--color-bg);
  }
  .cover.placeholder {
    background: var(--color-bg);
    border: 1px dashed var(--color-border);
  }
  .body {
    min-width: 0;
  }
  .title {
    margin: 0 0 var(--space-sm) 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
  }
  .title a {
    color: var(--color-text);
    text-decoration: none;
  }
  .title a:hover {
    text-decoration: underline;
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
  .actions {
    display: flex;
    gap: var(--space-xs);
  }
  .delete {
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-heading);
    line-height: 1;
  }
  .delete:hover {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .restore {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
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
</style>

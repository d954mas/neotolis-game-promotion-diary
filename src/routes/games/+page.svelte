<script lang="ts">
  // /games — list view with ?view=trash support.
  //
  // Normal view: GameCard grid + inline new-game form.
  // Trash view (?view=trash): deleted games as full GameCard cards with
  // Restore + Delete forever actions, same pattern as /feed?view=trash.

  import { invalidateAll, goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import GameCard from "$lib/components/GameCard.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import Toast from "$lib/components/shared/Toast.svelte";
  import type { PageData } from "./$types";

  type GameDto = {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    releaseTba: boolean;
    tags: string[];
    description: string | null;
    deletedAt: string | null;
    eventCount?: number;
  };

  let { data }: { data: PageData & { retentionDays: number } } = $props();

  // Trash view conditional.
  let trashView = $derived(data.view === "trash");

  const games = $derived(data.games as GameDto[]);
  const softDeleted = $derived(data.softDeleted as GameDto[]);

  let showForm = $state(false);
  let newTitle = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  async function submitNewGame(e: Event): Promise<void> {
    e.preventDefault();
    if (creating || newTitle.trim().length === 0) return;
    creating = true;
    createError = null;
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!res.ok) {
        createError = m.error_server_generic();
        return;
      }
      const created = (await res.json()) as { id: string };
      newTitle = "";
      showForm = false;
      await goto(`/games/${created.id}`);
    } catch {
      createError = m.error_network();
    } finally {
      creating = false;
    }
  }

  // Toast state.
  let toast = $state<{ kind: "success" | "info" | "danger"; text: string } | null>(null);

  // Trash view: per-card Restore handler.
  async function restoreGame(id: string): Promise<void> {
    const res = await fetch(`/api/games/${id}/restore`, { method: "POST" });
    if (res.ok || res.status === 204) {
      toast = { kind: "success", text: m.toast_game_restored() };
      await invalidateAll();
    } else {
      toast = { kind: "danger", text: m.error_server_generic() };
    }
  }

  // Trash view: Delete-forever state + confirm dialog.
  let deleteForeverId = $state<string | null>(null);
  let deleteForeverTitle = $state<string>("");
  let confirmDeleteForeverOpen = $state(false);

  function askDeleteForever(id: string, title: string): void {
    deleteForeverId = id;
    deleteForeverTitle = title;
    confirmDeleteForeverOpen = true;
  }

  async function confirmDeleteForever(): Promise<void> {
    if (!deleteForeverId) return;
    confirmDeleteForeverOpen = false;
    try {
      const res = await fetch(`/api/games/${deleteForeverId}?force=true`, { method: "DELETE" });
      if (!res.ok) {
        toast = { kind: "danger", text: m.error_server_generic() };
        return;
      }
      toast = { kind: "success", text: m.toast_game_deleted_forever() };
      deleteForeverId = null;
      await invalidateAll();
    } catch {
      toast = { kind: "danger", text: m.error_network() };
    }
  }
</script>

<section class="games">
  {#if trashView}
    <!-- Trash view — renders deleted games as full GameCard cards. -->
    <PageHeader title={m.games_page_title_trash()} sticky />

    <div class="trash-banner" role="status">
      <a class="trash-back" href="/games">← {m.games_trash_back()}</a>
      <span class="trash-banner-text"
        >{m.games_trash_banner_text({ days: data.retentionDays })}</span
      >
    </div>

    {#if softDeleted.length === 0}
      <div class="trash-empty" role="status">
        <h2 class="trash-empty-heading">{m.games_trash_empty_heading()}</h2>
        <p class="trash-empty-body">{m.games_trash_empty_body({ days: data.retentionDays })}</p>
        <a href="/games" class="trash-back-link">{m.games_trash_back()}</a>
      </div>
    {:else}
      <ul class="grid">
        {#each softDeleted as g (g.id)}
          <li>
            <GameCard
              game={{
                id: g.id,
                title: g.title,
                coverUrl: g.coverUrl,
                releaseDate: g.releaseDate,
                releaseTba: g.releaseTba,
                tags: g.tags,
                description: g.description,
                deletedAt: g.deletedAt,
                eventCount: g.eventCount ?? 0,
              }}
              view="trash"
              onRestore={() => restoreGame(g.id)}
              onDeleteForever={() => askDeleteForever(g.id, g.title)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <!-- Normal view. -->
    <PageHeader
      title="Games"
      cta={{
        onClick: () => {
          showForm = !showForm;
        },
        label: m.games_cta_new_game(),
      }}
      sticky
      deletedCount={softDeleted.length}
      onOpenRecovery={() => goto("/games?view=trash")}
    />

    {#if showForm}
      <form class="newgame" onsubmit={submitNewGame}>
        <label class="field">
          <span class="label">Title *</span>
          <input class="input" type="text" bind:value={newTitle} required maxlength="200" />
        </label>
        <div class="actions">
          <button type="button" class="cancel" onclick={() => (showForm = false)}>
            {m.common_cancel()}
          </button>
          <button type="submit" class="submit" disabled={creating || newTitle.trim().length === 0}>
            {m.games_cta_new_game()}
          </button>
        </div>
        {#if createError}
          <InlineError message={createError} />
        {/if}
      </form>
    {/if}

    {#if games.length === 0}
      <EmptyState
        heading={m.empty_games_heading()}
        body={m.empty_games_body({
          url: "https://store.steampowered.com/app/1145360/HADES/",
        })}
        exampleUrl="https://store.steampowered.com/app/1145360/HADES/"
        ctaLabel={m.games_cta_new_game()}
        onCta={() => (showForm = true)}
      />
    {:else}
      <ul class="grid">
        {#each games as g (g.id)}
          <li>
            <GameCard
              game={{
                id: g.id,
                title: g.title,
                coverUrl: g.coverUrl,
                releaseDate: g.releaseDate,
                releaseTba: g.releaseTba,
                tags: g.tags,
                description: g.description,
                deletedAt: g.deletedAt,
                eventCount: g.eventCount ?? 0,
              }}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <ConfirmDialog
    open={confirmDeleteForeverOpen}
    message={m.games_trash_confirm_delete_forever({ title: deleteForeverTitle })}
    confirmLabel={m.games_trash_delete_forever()}
    onConfirm={confirmDeleteForever}
    onCancel={() => (confirmDeleteForeverOpen = false)}
  />

  {#if toast}
    <Toast kind={toast.kind} text={toast.text} onclose={() => (toast = null)} />
  {/if}
</section>

<style>
  .games {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-4);
  }
  @media (min-width: 768px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (min-width: 1024px) {
    .grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  /* Trash banner — ← back link left, then text. */
  .trash-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
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

  /* Trash empty state. */
  .trash-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-8) var(--s-4);
    max-width: 560px;
    margin: 0 auto;
  }
  .trash-empty-heading {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: var(--lh-tight);
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

  /* Inline "+ New game" form. */
  .newgame {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    max-width: 720px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .label {
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .input {
    min-height: var(--hit-lg);
    padding: 0 var(--s-3);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: var(--t-14);
    font-family: var(--f-sans);
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input::placeholder {
    color: var(--text-3);
  }
  .input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
  }
  .cancel {
    background: transparent;
    color: var(--text-2);
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }
  .submit {
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-weight: var(--w-sb);
    font-size: var(--t-14);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .submit:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .submit {
      transition: none;
    }
  }
</style>

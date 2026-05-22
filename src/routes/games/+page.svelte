<script lang="ts">
  // /games — list view.
  //
  // Empty state with Steam URL example. Populated state stacks
  // <GameCard> rows; CSS grid breaks to 2-col at 768px (RetentionBadge
  // appears in the soft-deleted section). The "+ New game" CTA opens an
  // inline form that POSTs /api/games and navigates to the new game's
  // detail page on success.

  import { invalidateAll, goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import GameCard from "$lib/components/GameCard.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  // Shared PageHeader uses the onClick CTA variant so the toggle behavior
  // (showForm = true) stays a button (not a link).
  import PageHeader from "$lib/components/PageHeader.svelte";
  // RecoveryDialog modal — same single recovery surface across the app
  // (/feed, /games, /sources). The user surfaced this during UAT (verbatim, ru):
  //   "и так сделать для всеху удаленных обьектов на других страницах"
  //   ("and do the same for all deleted objects on other pages")
  // The dialog opens from PageHeader's "Recently deleted (N)" button.
  // entityType="game" lets RecoveryDialog forward-style per-type even though
  // the visual treatment is identical today.
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import type { PageData } from "./$types";

  type GameDto = {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: string | null;
    releaseTba: boolean;
    tags: string[];
    deletedAt: string | null;
  };

  let { data }: { data: PageData & { retentionDays: number } } = $props();

  const games = $derived(data.games as GameDto[]);
  const softDeleted = $derived(data.softDeleted as GameDto[]);

  let showForm = $state(false);
  let newTitle = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  let confirmOpen = $state(false);
  let pendingDeleteId = $state<string | null>(null);
  let pendingDeleteTitle = $state("");

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

  function askDelete(g: GameDto): void {
    pendingDeleteId = g.id;
    pendingDeleteTitle = g.title;
    confirmOpen = true;
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDeleteId) return;
    const res = await fetch(`/api/games/${pendingDeleteId}`, { method: "DELETE" });
    confirmOpen = false;
    pendingDeleteId = null;
    if (res.ok || res.status === 204) await invalidateAll();
  }

  // RecoveryDialog open state. Opened by PageHeader's "Recently deleted
  // (N)" button; closed by Escape, backdrop click, the dialog's × button,
  // or auto-closes when the last recoverable item is restored (same
  // contract as /feed).
  let recoveryOpen = $state(false);

  // Map softDeleted (toGameDto-projected, no ciphertext) into the
  // RecoveryDialog's generic { id, name, deletedAt } shape. `name` falls
  // back from `title` — every game has a non-empty title by schema, so
  // this is a straight projection, but the dialog's prop contract is
  // entity-agnostic.
  const recoveryItems = $derived(
    softDeleted.map((g) => ({
      id: g.id,
      name: g.title,
      deletedAt: g.deletedAt,
    })),
  );

  async function restoreGame(id: string): Promise<void> {
    const res = await fetch(`/api/games/${id}/restore`, { method: "POST" });
    if (res.ok || res.status === 204) {
      await invalidateAll();
      // If that was the last recoverable item, close the dialog so the
      // user is not stuck staring at "Nothing to recover" — the parent
      // also stops rendering the PageHeader CTA at the same time
      // (deletedCount falls to 0). Same pattern as /feed.
      if (softDeleted.length <= 1) recoveryOpen = false;
    }
  }
</script>

<section class="games">
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
    onOpenRecovery={() => (recoveryOpen = true)}
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
              deletedAt: g.deletedAt,
            }}
            onSoftDelete={() => askDelete(g)}
          />
        </li>
      {/each}
    </ul>
  {/if}

  <!-- The recovery flow lives in <RecoveryDialog> — a modal opened from
       PageHeader's "Recently deleted (N)" button. The dialog mounts only
       when softDeleted.length > 0; the dialog itself still defends against
       the empty case (renders the localized empty message). RetentionBadge
       is rendered INSIDE the dialog per item. -->
  {#if softDeleted.length > 0}
    <RecoveryDialog
      open={recoveryOpen}
      items={recoveryItems}
      entityType="game"
      retentionDays={data.retentionDays}
      onClose={() => (recoveryOpen = false)}
      onRestore={restoreGame}
    />
  {/if}

  <ConfirmDialog
    open={confirmOpen}
    message={m.confirm_game_delete({ title: pendingDeleteTitle })}
    confirmLabel={m.common_delete()}
    onConfirm={confirmDelete}
    onCancel={() => {
      confirmOpen = false;
      pendingDeleteId = null;
    }}
  />
</section>

<style>
  .games {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  /* Inline .head + .cta CSS were replaced by the shared <PageHeader>
   * component (see top of file). PageHeader uses the inline-on-the-left
   * flex layout. The onClick CTA variant preserves the inline-form-toggle
   * behavior (showForm = !showForm). */
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
  /* Inline "+ New game" form. Bound to 720px so it does not sprawl the
   * full grid width. Matches /sources/new + /sources/[id] form widths. */
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
  /* Prototype-aligned input: 40px height, surface-2 bg, focus ring on
   * accent border. Matches .field-input across modal + route forms. */
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
  /* The recovery flow uses RecoveryDialog (same component on /feed and
   * /sources). */
</style>

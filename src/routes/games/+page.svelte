<script lang="ts">
  // /games — list view (Plan 02-10).
  //
  // Empty state with Steam URL example (UI-SPEC §"/games (NEW — list)").
  // Populated state stacks <GameCard> rows; CSS grid breaks to 2-col at
  // 768px (RetentionBadge appears in the soft-deleted section). The
  // "+ New game" CTA opens an inline form that POSTs /api/games and
  // navigates to the new game's detail page on success.

  import { invalidateAll, goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import GameCard from "$lib/components/GameCard.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  // Plan 02.1-25 (UAT-NOTES.md §3.1-polish): shared PageHeader replaces the
  // inline <header class="head"> + button. Uses the onClick CTA variant so
  // the toggle behavior (showForm = true) stays a button (not a link).
  import PageHeader from "$lib/components/PageHeader.svelte";
  // Plan 02.1-39 round-6 polish #11 follow-up (UAT-NOTES.md §5.8 follow-up
  // #11 extension, 2026-04-30): the RecoveryDialog modal that landed on
  // /feed in c98eadf is extended to /games — same single recovery surface
  // across the app. The user surfaced this during UAT (verbatim, ru):
  //   "и так сделать для всеху удаленных обьектов на других страницах"
  //   ("and do the same for all deleted objects on other pages")
  // The previous bottom-of-page <details class="trash"> block is REMOVED;
  // the dialog opens from PageHeader's "Recently deleted (N)" button. This
  // also matches the pattern for /sources and any future surface that
  // surfaces soft-deleted entities — entityType="game" lets RecoveryDialog
  // forward-style per-type even though the visual treatment is identical
  // today.
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

  // Plan 02.1-39 round-6 polish #11 follow-up: RecoveryDialog open state.
  // Opened by PageHeader's "Recently deleted (N)" button; closed by
  // Escape, backdrop click, the dialog's × button, or auto-closes when
  // the last recoverable item is restored (same contract as /feed).
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

  <!-- Plan 02.1-39 round-6 polish #11 follow-up (UAT-NOTES.md §5.8 follow-up
       #11 extension): the bottom-of-page <details class="trash"> recovery
       block is REMOVED. The same flow now lives in <RecoveryDialog> — a
       modal opened from PageHeader's "Recently deleted (N)" button. The
       dialog mounts only when softDeleted.length > 0; the dialog itself
       still defends against the empty case (renders the localized empty
       message). RetentionBadge is rendered INSIDE the dialog per item. -->
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
    gap: var(--space-lg);
    min-width: 0;
  }
  /* Plan 02.1-25: inline .head + .cta CSS removed — replaced by the shared
   * <PageHeader> component (see top of file). PageHeader uses the inline-
   * on-the-left flex layout per UAT-NOTES.md §3.1-polish. The onClick CTA
   * variant preserves the inline-form-toggle behavior (showForm = !showForm). */
  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--space-md);
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
  .newgame {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
  }
  .cancel {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Plan 02.1-39 round-6 polish #11 follow-up: .trash + .trashrow CSS
   * removed alongside the bottom-of-page <details> recovery block.
   * RecoveryDialog owns the surface (same component on /feed and /sources). */
</style>

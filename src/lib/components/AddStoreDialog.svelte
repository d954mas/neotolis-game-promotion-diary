<script lang="ts">
  // AddStoreDialog — modal wrapper around <AddSteamListingForm> for
  // /games/[gameId]'s "Add Store" affordance.
  //
  // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14,
  // 2026-04-30). User during round-6 UAT after polish #13 landed
  // (verbatim, ru):
  //   "сейчас добавление стора сделано полями на этой странице. Я хочу
  //    через кнопку add рядом с заголовкот Stores"
  //   ("right now adding a store is done with fields on the page. I
  //    want it via an Add button next to the Stores heading.")
  //
  // Polish #13 placed the Add CTA at the bottom of StoresSection (the
  // ".add-row" block), expanding the form INLINE on the page. Polish
  // #14c reverts this back to a button NEXT TO the Stores h2 — but the
  // click now opens THIS modal instead of expanding inline. The
  // existing <AddSteamListingForm> renders inside the dialog body
  // unchanged.
  //
  // Pattern follows RecoveryDialog / ConfirmDialog / GameEditDialog:
  // native <dialog> + showModal() (focus trap + Escape close) +
  // backdrop-click closes via target===dialogEl + .dialog[open] CSS
  // scoping (commit 087a2fc) so the closed state stays hidden.
  //
  // Phase 2.1 ships Steam-only behind the new shell. Per
  // UAT-NOTES.md §4.25.C, Itch + Epic are explicitly DEFERRED (no
  // platform selector). Phase 3+ promotes AddSteamListingForm to a
  // per-platform sub-form and adds a platform picker above it; the
  // dialog wrapping pattern stays the same.

  import { m } from "$lib/paraglide/messages.js";
  import AddSteamListingForm from "./AddSteamListingForm.svelte";

  let {
    open,
    gameId,
    onClose,
    onSuccess,
  }: {
    open: boolean;
    gameId: string;
    onClose: () => void;
    onSuccess: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  function onDialogCancel(e: Event): void {
    e.preventDefault();
    onClose();
  }

  function onDialogClick(e: MouseEvent): void {
    if (e.target === dialogEl) onClose();
  }
</script>

<dialog bind:this={dialogEl} class="dialog" oncancel={onDialogCancel} onclick={onDialogClick}>
  <header class="header">
    <h2 class="heading">{m.add_store_dialog_heading()}</h2>
    <button type="button" class="close" aria-label={m.common_close()} onclick={onClose}> × </button>
  </header>
  <div class="body">
    <!--
      AddSteamListingForm fires onSuccess when the POST returns 201/200.
      We propagate that up — the parent closes the dialog + invalidates
      the loader. The form's duplicate-toast (existingGameId deep link)
      stays inside the dialog so the user can read it before deciding
      whether to close.
    -->
    <AddSteamListingForm {gameId} {onSuccess} />
  </div>
</dialog>

<style>
  /* Mirrors RecoveryDialog / GameEditDialog visual treatment so the
   * dialog patterns share one visual language. .dialog[open] scoping
   * (commit 087a2fc) keeps the closed state hidden. */
  .dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .dialog {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0;
    width: min(560px, calc(100vw - 2 * var(--space-md)));
    max-height: min(80vh, calc(100vh - 2 * var(--space-lg)));
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    overflow: hidden;
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-md) var(--space-lg);
    border-bottom: 1px solid var(--color-border);
  }
  .heading {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
  .close {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: var(--space-xs) var(--space-sm);
    border-radius: 4px;
  }
  .close:hover {
    color: var(--color-text);
    background: var(--color-bg);
  }
  .body {
    padding: var(--space-lg);
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
  }
</style>

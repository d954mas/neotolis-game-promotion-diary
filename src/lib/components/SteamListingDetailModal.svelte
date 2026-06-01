<script lang="ts">
  // SteamListingDetailModal — per-listing detail + advanced actions for one
  // Steam listing on /games/[gameId]. The card (SteamListingRow) stays
  // read-only; this modal is where the user does the "advanced" work:
  //   A) WISHLIST — full summary (or a recommendation when empty), how-to-
  //      export-from-Steam instructions, and the CSV import affordance. The
  //      modal stays OPEN after import so the result is visible; onChange
  //      invalidates the loader so the passed-in `summary` updates live.
  //   B) SETTINGS — label edit (Save) + Remove listing (ConfirmDialog).
  //      The PATCH / DELETE logic moved here from SteamListingRow.
  //
  // Pattern follows AddStoreDialog / ConfirmDialog: native <dialog> +
  // showModal() (focus trap + Escape close) + backdrop-click closes via
  // target===dialogEl + .dialog[open] CSS scoping. Body-scroll-lock is
  // handled globally by body:has(dialog[open]) in app.css — no JS lock.

  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";
  import WishlistImport from "./WishlistImport.svelte";
  import WishlistSummary from "./WishlistSummary.svelte";
  import type { WishlistSnapshotDto } from "$lib/server/dto.js";

  type Listing = {
    id: string;
    appId: number;
    label: string;
    name: string | null;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
  };

  type WishlistSummaryData = {
    balance: number;
    lastDate: string;
    recentDays: WishlistSnapshotDto[];
  };

  let {
    open,
    gameId,
    listing,
    summary = null,
    onClose,
    onChange,
  }: {
    open: boolean;
    gameId: string;
    listing: Listing;
    summary?: WishlistSummaryData | null;
    onClose: () => void;
    onChange?: () => void;
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

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());

  // Settings section — label edit. The draft buffer is seeded from the
  // current persisted label whenever the modal opens so a prior edit +
  // reload round-trip never carries a stale value.
  let labelDraft = $state(listing.label);
  let saving = $state(false);
  let editError = $state<string | null>(null);

  $effect(() => {
    if (open) {
      labelDraft = listing.label;
      editError = null;
    }
  });

  async function saveEdit(e: Event): Promise<void> {
    e.preventDefault();
    if (saving) return;
    saving = true;
    editError = null;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: labelDraft }),
      });
      if (!res.ok) {
        editError = m.error_server_generic();
        return;
      }
      onChange?.();
    } catch {
      editError = m.error_network();
    } finally {
      saving = false;
    }
  }

  let confirmOpen = $state(false);
  let removing = $state(false);

  async function handleRemoveConfirmed(): Promise<void> {
    if (removing) return;
    removing = true;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        confirmOpen = false;
        onChange?.();
        onClose();
      }
    } finally {
      removing = false;
    }
  }
</script>

<dialog bind:this={dialogEl} class="dialog" oncancel={onDialogCancel} onclick={onDialogClick}>
  <header class="header">
    <h2 class="heading">{m.steam_listing_detail_modal_heading({ name: displayName })}</h2>
    <button type="button" class="close" aria-label={m.common_close()} onclick={onClose}> × </button>
  </header>
  <div class="body">
    <section class="modal-section" aria-label={m.steam_listing_detail_section_wishlist()}>
      <h3 class="section-subheading">{m.steam_listing_detail_section_wishlist()}</h3>
      {#if summary}
        <WishlistSummary {summary} />
      {:else}
        <p class="recommendation">{m.steam_listing_wishlist_recommendation()}</p>
      {/if}

      <div class="export-help">
        <h4 class="export-heading">{m.wishlist_export_heading()}</h4>
        <ol class="export-steps">
          <li>{m.wishlist_export_step_1()}</li>
          <li>{m.wishlist_export_step_2()}</li>
          <li>{m.wishlist_export_step_3()}</li>
          <li>{m.wishlist_export_step_4()}</li>
        </ol>
      </div>

      <WishlistImport {gameId} listingId={listing.id} onImported={() => onChange?.()} />
    </section>

    <section class="modal-section" aria-label={m.steam_listing_detail_section_settings()}>
      <h3 class="section-subheading">{m.steam_listing_detail_section_settings()}</h3>
      <form class="edit-form" onsubmit={saveEdit}>
        <label class="edit-field">
          <span class="edit-field-label">{m.steam_listing_label_edit_label()}</span>
          <input
            class="edit-input"
            type="text"
            bind:value={labelDraft}
            maxlength="100"
            placeholder="Demo / Full / DLC / OST"
            disabled={saving}
          />
        </label>
        <div class="edit-actions">
          <button type="submit" class="edit-save" disabled={saving}>
            {m.steam_listing_edit_save_cta()}
          </button>
          <button
            type="button"
            class="remove-btn-inline"
            aria-label={m.steam_listing_remove_aria()}
            onclick={() => (confirmOpen = true)}
            disabled={removing || saving}
          >
            × {m.common_remove()}
          </button>
        </div>
        {#if editError}<InlineError message={editError} />{/if}
      </form>
    </section>
  </div>
</dialog>

<ConfirmDialog
  open={confirmOpen}
  message={m.confirm_listing_remove_title() + " " + m.confirm_listing_remove_body()}
  confirmLabel={m.common_remove()}
  onConfirm={handleRemoveConfirmed}
  onCancel={() => (confirmOpen = false)}
/>

<style>
  /* Mirrors AddStoreDialog / ConfirmDialog visual treatment so the dialog
   * patterns share one visual language. .dialog[open] scoping keeps the
   * closed state hidden. */
  .dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .dialog {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 0;
    width: min(560px, calc(100vw - 2 * var(--s-4)));
    max-height: min(80vh, calc(100vh - 2 * var(--s-6)));
    box-shadow: var(--shadow-elev);
    overflow: hidden;
  }
  .dialog::backdrop {
    background: var(--overlay-dark);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-6);
    border-bottom: 1px solid var(--border);
  }
  .heading {
    margin: 0;
    font-size: var(--t-17);
    font-weight: var(--w-sb);
    color: var(--text);
    word-break: break-word;
    min-width: 0;
  }
  .close {
    background: transparent;
    color: var(--text-3);
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .close:hover {
    color: var(--text);
    background: var(--accent-soft);
  }
  .body {
    padding: var(--s-6);
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
  /* Two labelled sections separated by a divider above the second one. */
  .modal-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .modal-section + .modal-section {
    padding-top: var(--s-6);
    border-top: 1px solid var(--border);
  }
  .section-subheading {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .recommendation {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
  }
  .export-help {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .export-heading {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
  }
  .export-steps {
    margin: 0;
    padding-left: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: var(--lh-body);
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .edit-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .edit-field-label {
    font-family: var(--f-sans);
    font-size: var(--t-13);
    color: var(--text-2);
    font-weight: var(--w-md);
  }
  .edit-input {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    width: 100%;
    box-sizing: border-box;
  }
  .edit-actions {
    display: flex;
    gap: var(--s-1);
    flex-wrap: wrap;
  }
  .edit-save,
  .remove-btn-inline {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .edit-save {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
  }
  .edit-save:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .edit-save:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .remove-btn-inline {
    margin-left: auto;
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .remove-btn-inline:hover:not(:disabled) {
    background: var(--danger);
    color: #fff;
  }
  .remove-btn-inline:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .close,
    .edit-save,
    .remove-btn-inline {
      transition: none;
    }
  }
</style>

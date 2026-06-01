<script lang="ts">
  // SteamListingDetailModal — per-listing detail + advanced actions for one
  // Steam listing on /games/[gameId]. The card (SteamListingRow) stays
  // read-only; this modal is where the user does the advanced work: label
  // inline edit, wishlist summary + CSV import, and the soft-delete action.
  // Hard-delete (delete forever) lives in the trash view, not here.
  //
  // Pattern follows AddStoreDialog / ConfirmDialog: native <dialog> +
  // showModal() (focus trap + Escape close) + backdrop-click closes via
  // target===dialogEl. Body-scroll-lock is handled globally by
  // body:has(dialog[open]) in app.css — no JS lock.

  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";
  import WishlistImport from "./WishlistImport.svelte";
  import WishlistSummary from "./WishlistSummary.svelte";
  import type { WishlistSummaryDto } from "$lib/server/dto.js";

  type Listing = {
    id: string;
    appId: number;
    label: string;
    name: string | null;
    coverUrl: string | null;
    releaseDate: string | null;
    apiKeyId: string | null;
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
    summary?: WishlistSummaryDto | null;
    onClose: () => void;
    onChange?: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);

  // `closing` guards the label input's onblur=commitEditLabel: dismissing the
  // modal (× / Escape / backdrop) blurs the focused input, which would
  // otherwise PATCH a label the user abandoned by closing. Every close path
  // sets it true BEFORE onClose(); the open-$effect resets it to false.
  let closing = $state(false);

  function close(): void {
    closing = true;
    onClose();
  }

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      closing = false;
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  function onDialogCancel(e: Event): void {
    e.preventDefault();
    // Escape dismisses one level at a time: close the overflow menu first if
    // it's open, otherwise close the whole modal.
    if (overflowOpen) {
      overflowOpen = false;
      return;
    }
    close();
  }

  function onDialogClick(e: MouseEvent): void {
    if (e.target === dialogEl) close();
  }

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());

  // Header overflow menu (EventDetailHeader idiom). Escape is handled by the
  // dialog's `cancel` (onDialogCancel) — menu first, then the modal.
  let overflowOpen = $state(false);

  // Label inline edit (EventDetailContent idiom). `null` = not editing;
  // string = current draft. Commit on blur AND Enter; Esc reverts + exits.
  // Editing flag is `labelDraft !== null` — no separate boolean needed.
  let labelDraft = $state<string | null>(null);
  let editError = $state<string | null>(null);

  // Re-seed on close so a prior edit + reload round-trip never carries a
  // stale draft into the next open.
  $effect(() => {
    if (!open) {
      labelDraft = null;
      editError = null;
    }
  });

  function startEditLabel(): void {
    labelDraft = listing.label;
    editError = null;
  }

  function cancelEditLabel(): void {
    labelDraft = null;
    editError = null;
  }

  async function commitEditLabel(): Promise<void> {
    if (labelDraft === null) return;
    // A close-triggered blur must NOT commit an abandoned edit. Drop the draft
    // and bail when the modal is closing.
    if (closing) {
      labelDraft = null;
      return;
    }
    const next = labelDraft;
    // No-op when unchanged — close the editor without a roundtrip.
    if (next === listing.label) {
      labelDraft = null;
      return;
    }
    editError = null;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: next }),
      });
      if (!res.ok) {
        editError = m.error_server_generic();
        return;
      }
      labelDraft = null;
      onChange?.();
    } catch {
      editError = m.error_network();
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
        close();
      }
    } finally {
      removing = false;
    }
  }
</script>

<dialog bind:this={dialogEl} class="dialog" oncancel={onDialogCancel} onclick={onDialogClick}>
  <header class="header">
    <h2 class="heading">{m.steam_listing_detail_modal_heading({ name: displayName })}</h2>
    <div class="overflow-wrap">
      <button
        type="button"
        class="overflow-btn"
        onclick={() => (overflowOpen = !overflowOpen)}
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        aria-label={m.steam_listing_more_actions_aria()}
        title={m.steam_listing_more_actions_aria()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {#if overflowOpen}
        <button
          type="button"
          class="overflow-scrim"
          aria-label={m.common_close()}
          onclick={() => (overflowOpen = false)}
        ></button>
        <div class="overflow-pop" role="menu">
          <button
            type="button"
            class="card-menu-item danger"
            role="menuitem"
            onclick={() => {
              overflowOpen = false;
              confirmOpen = true;
            }}>{m.steam_listing_delete_cta()}</button
          >
        </div>
      {/if}
    </div>
    <button type="button" class="close" aria-label={m.common_close()} onclick={close}> × </button>
  </header>
  <div class="body">
    <!-- Label inline edit — EventDetailContent .detail-editable-row idiom. -->
    {#if labelDraft !== null}
      <input
        class="label-input"
        bind:value={labelDraft}
        onblur={commitEditLabel}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEditLabel();
          }
        }}
        maxlength="100"
        placeholder="Demo / Full / DLC / OST"
        aria-label={m.steam_listing_label_edit_aria()}
      />
    {:else if listing.label}
      <div class="detail-editable-row label-row">
        <p class="label-text">
          <span class="label-prefix">{m.steam_listing_label_prefix()}</span>
          {listing.label}
        </p>
        <button
          type="button"
          class="detail-edit-btn"
          onclick={startEditLabel}
          aria-label={m.steam_listing_label_edit_aria()}
          title={m.steam_listing_label_edit_aria()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M11 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      </div>
    {:else}
      <button type="button" class="label-empty-btn" onclick={startEditLabel}>
        {m.steam_listing_label_add()}
      </button>
    {/if}
    {#if editError}<InlineError message={editError} />{/if}

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
        <!-- Deep-link to THIS app's wishlist report PAGE (user still picks
             "all history" + "view as .csv" there). We link the stable report
             page, not the report_csv.php direct-download URL, which bakes in
             dates + interpreter params and would break. -->
        <a
          class="export-open-report"
          href={`https://partner.steampowered.com/app/wishlist/${listing.appId}/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {m.wishlist_export_open_report()}
        </a>
      </div>

      <WishlistImport {gameId} listingId={listing.id} onImported={() => onChange?.()} />
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
    gap: var(--s-2);
    padding: var(--s-4) var(--s-6);
    border-bottom: 1px solid var(--border);
  }
  .heading {
    margin: 0;
    flex: 1;
    font-size: var(--t-17);
    font-weight: var(--w-sb);
    color: var(--text);
    word-break: break-word;
    min-width: 0;
  }
  /* ── Header overflow menu (EventDetailHeader idiom) ─────────────────── */
  .overflow-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .overflow-btn {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    transition:
      background var(--m-fast),
      color var(--m-fast),
      border-color var(--m-fast);
  }
  .overflow-btn:hover,
  .overflow-btn[aria-expanded="true"] {
    background: var(--surface-3);
    border-color: var(--border);
    color: var(--text);
  }
  .overflow-scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
  }
  .overflow-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex;
    flex-direction: column;
    z-index: 90;
  }
  .overflow-pop .card-menu-item {
    background: transparent;
    border: none;
    text-align: left;
    padding: 8px 12px;
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
    font-family: inherit;
  }
  .overflow-pop .card-menu-item:hover {
    background: var(--accent-soft);
  }
  .overflow-pop .card-menu-item.danger {
    color: var(--danger);
  }
  .overflow-pop .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
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
    flex-shrink: 0;
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
  /* ── Label inline edit (EventDetailContent idiom) ───────────────────── */
  .detail-editable-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .detail-editable-row > :first-child {
    flex: 1;
    min-width: 0;
  }
  .label-text {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-14);
  }
  .label-prefix {
    font-weight: var(--w-sb);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 4px;
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .detail-edit-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    opacity: 0.55;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast),
      opacity var(--m-fast);
  }
  @media (hover: hover) {
    .detail-editable-row:hover .detail-edit-btn {
      opacity: 1;
    }
  }
  @media (hover: none) {
    .detail-edit-btn {
      opacity: 0.7;
    }
  }
  .detail-edit-btn:hover {
    background: var(--surface-3);
    border-color: var(--border);
    color: var(--text);
    opacity: 1;
  }
  .label-empty-btn {
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 4px 8px;
    margin-left: -8px;
    text-align: left;
    color: var(--text-3);
    font-style: italic;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    border-radius: var(--r-sm);
    transition: color var(--m-fast) var(--m-ease);
  }
  .label-empty-btn:hover {
    color: var(--text-2);
  }
  .label-input {
    width: calc(100% + 16px);
    margin-left: -8px;
    padding: 4px 8px;
    background: var(--surface-3);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
    box-sizing: border-box;
  }
  .modal-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
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
  .export-open-report {
    align-self: flex-start;
    color: var(--accent);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    text-decoration: none;
  }
  .export-open-report:hover {
    text-decoration: underline;
  }
  @media (prefers-reduced-motion: reduce) {
    .close,
    .overflow-btn,
    .detail-edit-btn,
    .label-empty-btn {
      transition: none;
    }
  }
</style>

<script lang="ts">
  // SteamListingRow — one Steam listing on /games/[id] under StoresSection.
  //
  // Card content order (top → bottom):
  //   1. Cover image (when listing.coverUrl is non-null) — Steam header
  //      image rendered as the visual anchor. Falls back to a flat
  //      surface when null (Steam-down-on-INSERT case).
  //   2. Header row: STEAM badge + name. Badge is a small accent pill
  //      identifying the store.
  //   3. App ID line ("App {appId}") in muted monospace.
  //   4. Optional user label (when listing.label is non-empty) — prefixed
  //      with "Label:" so the user knows what that text is.
  //   5. Optional release date (when listing.releaseDate is non-null).
  //   6. Optional "key linked" chip when listing.apiKeyId is non-null.
  //   7. "Open in Steam" deep-link CTA.
  //
  // Per-card edit-mode:
  //   - A small Edit button at the top-right corner of the card.
  //   - Click → flips local `editing` state. In edit mode the card
  //     reveals an inline `<form class="edit-form">` with a label
  //     input + Save / Cancel + × Remove (the destructive action stays
  //     gated behind ConfirmDialog). Edit button hides.
  //   - Save → PATCH /api/games/:gameId/listings/:listingId { label }
  //     → onChange() so the parent invalidates and the new label
  //     surfaces. Cancel reverts the local input value + flips back.
  //   - Label is the only mutable field today; the form layout
  //     accommodates future fields (release-date / categories override)
  //     inside `.edit-form` scoped to `editing === true`.
  //
  // displayName: prefer the persisted `name`; fall back to
  // m.steam_listing_unnamed() for legacy rows (NULL `name`) or rows added
  // during a Steam outage.
  //
  // steamUrl: `https://store.steampowered.com/app/{appId}/` — public Steam
  // store URL, no auth needed. `target="_blank"` + `rel="noopener noreferrer"`
  // is the standard external-link safety pair.

  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";

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
    listing,
    gameId,
    onChange,
  }: {
    listing: Listing;
    // gameId is OPTIONAL for backward compatibility with any callers that
    // render the row outside StoresSection. When omitted, the Edit / Remove
    // affordances hide (no DELETE target).
    gameId?: string;
    onChange?: () => void;
  } = $props();

  // Per-card edit-mode state owned by each card.
  let editing = $state(false);

  // Inline label edit form state. Initialized lazily when the user
  // enters edit mode so the buffer always reflects the latest server
  // value (a previous edit + reload round-trip would otherwise carry
  // the stale buffer).
  let labelDraft = $state(listing.label);
  let saving = $state(false);
  let editError = $state<string | null>(null);

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);

  let confirmOpen = $state(false);
  let removing = $state(false);

  function startEdit(): void {
    // Pull the current persisted label into the draft buffer so the
    // input reflects what's saved (not whatever was typed during a
    // prior open). Clear any stale error from a previous failed save.
    labelDraft = listing.label;
    editError = null;
    editing = true;
  }

  function cancelEdit(): void {
    if (saving) return;
    labelDraft = listing.label;
    editError = null;
    editing = false;
  }

  async function saveEdit(e: Event): Promise<void> {
    e.preventDefault();
    if (saving || !gameId) return;
    saving = true;
    editError = null;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: labelDraft }),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore */
        }
        editError =
          code === "validation_failed" ? m.error_server_generic() : m.error_server_generic();
        return;
      }
      // Success — flip back to read mode + ask the parent to refresh.
      editing = false;
      onChange?.();
    } catch {
      editError = m.error_network();
    } finally {
      saving = false;
    }
  }

  async function handleRemoveConfirmed(): Promise<void> {
    if (removing || !gameId) return;
    removing = true;
    try {
      const res = await fetch(`/api/games/${gameId}/listings/${listing.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        confirmOpen = false;
        editing = false;
        onChange?.();
      }
    } finally {
      removing = false;
    }
  }
</script>

<article class="store-card">
  {#if listing.coverUrl}
    <!-- Cover image at the top of the card. The Steam header image
         dimensions are 460×215 (~2.14:1); the CSS aspect-ratio keeps the
         image proportional even if Steam returns a different size in
         the future. -->
    <img
      class="store-cover"
      src={listing.coverUrl}
      alt={m.steam_listing_cover_alt({ name: displayName })}
      loading="lazy"
    />
  {/if}
  <header class="store-card-header">
    <!-- STEAM badge identifies the store kind. Today there's only one
         kind; future stores (Itch, Epic) extend this badge with a
         kind-aware label via the same paraglide key family. -->
    <span class="kind-badge" data-kind="steam">{m.steam_listing_kind_steam()}</span>
    <h3 class="store-name">{displayName}</h3>
  </header>
  <p class="app-id">{m.steam_listing_app_id({ appId: listing.appId })}</p>
  {#if listing.label && !editing}
    <!-- Prefix "Label:" so the user knows what the free-text under the
         appId means. Hidden in edit mode (the inline form has its own
         labelled input below). -->
    <p class="user-label">
      <span class="label-prefix">{m.steam_listing_label_prefix()}</span>
      {listing.label}
    </p>
  {/if}
  {#if listing.releaseDate}
    <p class="release-date">{listing.releaseDate}</p>
  {/if}
  {#if listing.apiKeyId}
    <p class="key-linked-note">
      <span class="chip linked">key linked</span>
    </p>
  {/if}
  {#if !editing}
    <a class="cta-secondary store-link" href={steamUrl} target="_blank" rel="noopener noreferrer">
      {m.steam_listing_open_in_steam()}
    </a>
  {/if}
  {#if gameId}
    <!-- Per-card Edit toggle reveals an inline LABEL EDIT FORM in
         addition to the × Remove button. The Edit button at the
         top-right corner flips into a × Cancel-edit button while
         editing. -->
    {#if !editing}
      <button
        type="button"
        class="edit-btn"
        aria-label={m.steam_listing_edit_aria()}
        onclick={startEdit}
      >
        {m.common_edit()}
      </button>
    {:else}
      <button
        type="button"
        class="cancel-edit-btn"
        aria-label={m.common_close()}
        onclick={cancelEdit}
        disabled={saving}
      >
        ×
      </button>
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
          <button type="button" class="edit-cancel" onclick={cancelEdit} disabled={saving}>
            {m.common_cancel()}
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
    {/if}
  {/if}
</article>

<ConfirmDialog
  open={confirmOpen}
  message={m.confirm_listing_remove_title() + " " + m.confirm_listing_remove_body()}
  confirmLabel={m.common_remove()}
  onConfirm={handleRemoveConfirmed}
  onCancel={() => (confirmOpen = false)}
/>

<style>
  /* v2 SteamListingRow — D-01 redraw via SourceRow analogy. --surface-2
   * card + --r-md radius + --shadow-card elevation. data-kind="steam"
   * (LB-10) preserved. */
  .store-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-card);
    min-width: 0;
    overflow: hidden;
  }
  /* Cover image at the top of the card. Aspect ratio matches Steam's
   * standard header image (460×215). Bleed-to-edge so the card border
   * frames it cleanly. */
  .store-cover {
    display: block;
    width: calc(100% + 2 * var(--s-4));
    margin-top: calc(var(--s-4) * -1);
    margin-left: calc(var(--s-4) * -1);
    margin-right: calc(var(--s-4) * -1);
    aspect-ratio: 460 / 215;
    object-fit: cover;
    background: var(--surface-3);
  }
  .store-card-header {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    flex-wrap: wrap;
  }
  /* STEAM badge — accent pill identifying the store kind. */
  .kind-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--s-0) var(--s-2);
    background: var(--accent);
    color: var(--accent-text);
    border-radius: var(--r-xs);
    font-family: var(--f-sans);
    font-size: 0.6875rem;
    font-weight: var(--w-sb);
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .store-name {
    margin: 0;
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    word-break: break-word;
    min-width: 0;
  }
  .app-id {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: var(--t-12);
  }
  .user-label,
  .release-date {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .label-prefix {
    font-weight: var(--w-sb);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 4px;
    color: var(--text-3);
  }
  .key-linked-note {
    margin: 0;
  }
  .chip {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-0) var(--s-2);
  }
  .cta-secondary.store-link {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    text-decoration: none;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta-secondary.store-link:hover {
    background: var(--accent);
    color: var(--accent-text);
  }
  /* Per-card Edit / Cancel buttons. Top-right; dark translucent over
   * the cover image to stay legible. */
  .edit-btn,
  .cancel-edit-btn {
    position: absolute;
    top: var(--s-1);
    right: var(--s-1);
    min-height: 32px;
    min-width: 32px;
    padding: var(--s-1) var(--s-2);
    background: rgb(0 0 0 / 60%);
    color: #fff;
    border: 1px solid rgb(255 255 255 / 30%);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    z-index: 1;
    transition: background var(--m-fast) var(--m-ease);
  }
  .edit-btn:hover,
  .cancel-edit-btn:hover:not(:disabled) {
    background: rgb(0 0 0 / 80%);
  }
  .cancel-edit-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
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
    background: var(--surface-2);
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
  .edit-cancel,
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
  .edit-cancel {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .edit-cancel:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .edit-cancel:disabled {
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
    .cta-secondary.store-link,
    .edit-btn,
    .cancel-edit-btn,
    .edit-save,
    .edit-cancel,
    .remove-btn-inline {
      transition: none;
    }
  }
</style>

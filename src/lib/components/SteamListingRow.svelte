<script lang="ts">
  // SteamListingRow — one Steam listing on /games/[id] under StoresSection.
  //
  // Plan 02.1-25 (UAT-NOTES.md §3.3-polish): the user wanted Steam listings
  // to surface the game name (e.g. "Portal 2") + a way to open the Steam
  // store page. Quote: "Хотелось бы видеть еще название и способ перейти
  // в стим".
  //
  // Plan 02.1-30 (UAT-NOTES.md §4.25.H): adds a Remove icon button gated
  // by the page-level `editMode` toggle (mirrors Plan 02.1-22's SourceRow
  // edit pattern). Click → ConfirmDialog → DELETE
  // /api/games/:gameId/listings/:listingId → onChange() so the parent can
  // invalidateAll() and the listing disappears from the list.
  //
  // Plan 02.1-39 (UAT-NOTES.md §5.3 item A): row swaps to a card layout
  // (border + radius + padding; flex column) so cards lay out in
  // StoresSection's 3-per-row grid.
  //
  // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  // 2026-04-30): card content reordered + per-card Edit toggle replaces
  // the section-level editMode prop. User direction (verbatim, ru):
  //
  //   "На картчоке стора нужно имя, и картинка из стора. app id и
  //    обозначить стор(стим, итч)"
  //   ("Each store card needs the name, the image from the store, the
  //    app id, and a store-type marker (Steam, Itch).")
  //
  //   "кнопка edit она у каждой карточки стора, мелко и отдельно"
  //   ("the Edit button is on each store card, small and separate")
  //
  // Card content order (top → bottom):
  //   1. Cover image (when listing.coverUrl is non-null) — Steam header
  //      image rendered as the visual anchor. Falls back to a flat
  //      surface when null (Steam-down-on-INSERT case).
  //   2. Header row: STEAM badge + name. Badge is a small accent pill
  //      identifying the store.
  //   3. App ID line ("App {appId}") in muted monospace.
  //   4. Optional user label (when listing.label is non-empty) — now
  //      prefixed with "Label:" so the user knows what that text is
  //      (polish #14c clarification — "мне не понятно что так лейбл и
  //      где" / "I don't understand what 'label' is or where it lives").
  //   5. Optional release date (when listing.releaseDate is non-null).
  //   6. Optional "key linked" chip when listing.apiKeyId is non-null.
  //   7. "Open in Steam" deep-link CTA (preserved from §5.3 item A).
  //
  // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14,
  // 2026-04-30): per-card Edit toggle now reveals an inline LABEL EDIT
  // FORM in addition to the × Remove button. User direction (verbatim,
  // ru): "При редактировании стора, я бы хотел иметь возможноть
  // поменять label." Label is the only mutable field today (other §5.3
  // item B fields — release-date / categories — remain Phase 6
  // backlog); the form layout accommodates future fields by living
  // inside `.edit-form` block scoped to `editing === true`.
  //
  // Per-card edit-mode (polish #13 + #14c):
  //   - A small Edit button at the top-right corner of the card.
  //   - Click → flips local `editing` state. In edit mode the card
  //     reveals an inline `<form class="edit-form">` with a label
  //     input + Save / Cancel + × Remove (the destructive action stays
  //     gated behind ConfirmDialog as before). Edit button hides.
  //   - Save → PATCH /api/games/:gameId/listings/:listingId { label }
  //     → onChange() so the parent invalidates and the new label
  //     surfaces. Cancel reverts the local input value + flips back.
  //
  // displayName: prefer the persisted `name` (Plan 02.1-25 column added in
  // Task 1's migration 0004); fall back to m.steam_listing_unnamed() for
  // legacy rows (NULL `name`) or rows added during a Steam outage.
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

  // Plan 02.1-39 round-6 polish #13: per-card edit-mode state owned by
  // each card. Replaces the section-level `editMode` prop from §5.3.
  let editing = $state(false);

  // Plan 02.1-39 round-6 polish #14c: inline label edit form state.
  // Initialized lazily when the user enters edit mode so the buffer
  // always reflects the latest server value (a previous edit + reload
  // round-trip would otherwise carry the stale buffer).
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
          code === "validation_failed"
            ? m.error_server_generic()
            : m.error_server_generic();
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
    <!-- Plan 02.1-39 round-6 polish #13: cover image at the top of the
         card per user direction "картинка из стора". The Steam header
         image dimensions are 460×215 (~2.14:1); the CSS aspect-ratio
         keeps the image proportional even if Steam returns a different
         size in the future. -->
    <img
      class="store-cover"
      src={listing.coverUrl}
      alt={m.steam_listing_cover_alt({ name: displayName })}
      loading="lazy"
    />
  {/if}
  <header class="store-card-header">
    <!-- Plan 02.1-39 round-6 polish #13: STEAM badge identifies the
         store kind ("обозначить стор(стим, итч)"). Today there's only
         one kind; future stores (Itch, Epic) extend this badge with a
         kind-aware label via the same paraglide key family. -->
    <span class="kind-badge" data-kind="steam">{m.steam_listing_kind_steam()}</span>
    <h3 class="store-name">{displayName}</h3>
  </header>
  <p class="app-id">{m.steam_listing_app_id({ appId: listing.appId })}</p>
  {#if listing.label && !editing}
    <!-- Plan 02.1-39 round-6 polish #14c: prefix "Label:" so the user
         knows what the free-text under the appId means. Hidden in
         edit mode (the inline form has its own labelled input below). -->
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
    <a
      class="cta-secondary store-link"
      href={steamUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      {m.steam_listing_open_in_steam()}
    </a>
  {/if}
  {#if gameId}
    <!-- Plan 02.1-39 round-6 polish #14c: per-card Edit toggle now
         reveals an inline LABEL EDIT FORM in addition to the × Remove
         button. The Edit button at the top-right corner flips into a
         × Cancel-edit button while editing. -->
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
          <button
            type="button"
            class="edit-cancel"
            onclick={cancelEdit}
            disabled={saving}
          >
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
  /* Plan 02.1-39 (UAT-NOTES.md §5.3 item A): card layout — border + radius
   * + padding + flex column so each Steam listing reads as its own card
   * inside the StoresSection grid. Replaces Plan 02.1-30's row layout.
   *
   * Plan 02.1-39 round-6 polish #13: the cover image now anchors the
   * card visually. It's the FIRST child so the flow is image → header
   * → app id → meta → CTA — matching the user-direction sequence
   * "картинка → имя → STEAM → app id". */
  .store-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    min-width: 0;
    overflow: hidden;
  }
  /* Plan 02.1-39 round-6 polish #13: cover image at the top of the card.
   * Aspect ratio matches Steam's standard header image (460×215, ~2.14:1)
   * so the visual proportions stay stable even when Steam returns a
   * differently-sized asset. The image is bleed-to-edge on the top
   * (negative margins) so the card border frames it cleanly. */
  .store-cover {
    display: block;
    width: calc(100% + 2 * var(--space-md));
    margin-top: calc(var(--space-md) * -1);
    margin-left: calc(var(--space-md) * -1);
    margin-right: calc(var(--space-md) * -1);
    aspect-ratio: 460 / 215;
    object-fit: cover;
    background: var(--color-bg);
  }
  .store-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
    flex-wrap: wrap;
  }
  /* Plan 02.1-39 round-6 polish #13: STEAM badge — small accent pill
   * identifying the store kind. Future kinds (Itch, Epic) extend the
   * data-kind attribute with their own color tokens; today only "steam"
   * is wired (matching the schema). */
  .kind-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--space-sm);
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border-radius: 3px;
    font-size: 0.6875rem;
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .store-name {
    margin: 0;
    color: var(--color-text);
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    word-break: break-word;
    min-width: 0;
  }
  /* Plan 02.1-39 round-6 polish #13: app id surfaces in muted monospace
   * so it reads as a technical identifier (not body copy). User direction
   * "app id" — kept literal without translation. */
  .app-id {
    margin: 0;
    color: var(--color-text-muted);
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-label);
  }
  .user-label,
  .release-date {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  /* Plan 02.1-39 round-6 polish #14c: "Label:" prefix in front of the
   * free-text user label so the field is self-documenting. The prefix
   * uses the same muted token as the value but uppercases / weights
   * for visual hierarchy ("Label: Demo" reads as a key-value pair). */
  .label-prefix {
    font-weight: var(--font-weight-semibold);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 4px;
  }
  .key-linked-note {
    margin: 0;
  }
  .chip {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
  .cta-secondary.store-link {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    text-decoration: none;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
  }
  .cta-secondary.store-link:hover {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
  }
  /* Plan 02.1-39 round-6 polish #13: per-card Edit button. Sits at the
   * top-right corner of the card; small + secondary so it does not
   * compete with the card's reading flow. Replaces the section-level
   * Edit toggle from §5.3.
   *
   * Position: absolute relative to the card. When the cover image is
   * rendered, the button sits OVER the image's top-right corner — the
   * white-text + dark-translucent background keeps it legible on any
   * cover. When no cover, it sits over the surface — same visual
   * treatment for visual consistency. */
  .edit-btn {
    position: absolute;
    top: var(--space-xs);
    right: var(--space-xs);
    min-height: 32px;
    padding: 0 var(--space-sm);
    background: rgb(0 0 0 / 60%);
    color: #fff;
    border: 1px solid rgb(255 255 255 / 30%);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    z-index: 1;
  }
  .edit-btn:hover {
    background: rgb(0 0 0 / 80%);
  }
  /* Plan 02.1-39 round-6 polish #14c: inline label edit form. Replaces
   * polish #13's "edit mode reveals × Remove only" with a real form
   * (label input + Save / Cancel + × Remove). The form sits inline in
   * the card body — no modal — so the user can compare the new label
   * against the cover/name/appId without context-switching.
   *
   * The Cancel-edit × button at the top-right replaces the polish #13
   * Edit-button position (same coords) so the user can dismiss
   * without scrolling to find a Cancel. The form's own Save/Cancel
   * buttons are the primary affordance for the field edit; the top-
   * right × is the "discard + close" parallel of GameEditDialog's
   * close button. */
  .cancel-edit-btn {
    position: absolute;
    top: var(--space-xs);
    right: var(--space-xs);
    min-width: 32px;
    min-height: 32px;
    padding: 0 var(--space-sm);
    background: rgb(0 0 0 / 60%);
    color: #fff;
    border: 1px solid rgb(255 255 255 / 30%);
    border-radius: 4px;
    font-size: var(--font-size-label);
    cursor: pointer;
    z-index: 1;
  }
  .cancel-edit-btn:hover:not(:disabled) {
    background: rgb(0 0 0 / 80%);
  }
  .cancel-edit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-sm);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .edit-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .edit-field-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .edit-input {
    min-height: 36px;
    padding: 0 var(--space-sm);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    width: 100%;
    box-sizing: border-box;
  }
  .edit-actions {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }
  .edit-save {
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .edit-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .edit-cancel {
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .edit-cancel:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .remove-btn-inline {
    margin-left: auto;
    min-height: 36px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-destructive);
    border: 1px solid var(--color-destructive);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .remove-btn-inline:hover:not(:disabled) {
    background: var(--color-destructive);
    color: #fff;
  }
  .remove-btn-inline:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

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
  //      identifying the store. When future stores ship (Itch / Epic),
  //      this badge becomes kind-aware (Plan 7+ adds the discriminator).
  //   3. App ID line ("App {appId}") in muted monospace.
  //   4. Optional user label (when listing.label is non-empty).
  //   5. Optional release date (when listing.releaseDate is non-null).
  //   6. Optional "key linked" chip when listing.apiKeyId is non-null.
  //   7. "Open in Steam" deep-link CTA (preserved from §5.3 item A).
  //
  // Per-card edit affordance:
  //   - A small Edit button at the top-right corner of the card (same
  //     touch target shape as the previous Remove × had — 44×44).
  //   - Click → flips the card's LOCAL `editing` state; the × Remove
  //     button replaces the Edit button and the user can Confirm-Dialog
  //     their way through deletion.
  //   - Click again on Edit (which is now the × Remove during edit
  //     mode) cancels back. Per-card edit-mode replaces the section-
  //     level editMode prop entirely.
  //
  // Item B from §5.3 (full Steam-listing edit form — release-date /
  // label / categories override) is EXPLICITLY DEFERRED to Phase 6
  // polish backlog. Today's "Edit" toggle only reveals the Remove ×;
  // a future plan extends this state to surface a full edit panel.
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

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);

  let confirmOpen = $state(false);
  let removing = $state(false);

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
  {#if listing.label}
    <p class="user-label">{listing.label}</p>
  {/if}
  {#if listing.releaseDate}
    <p class="release-date">{listing.releaseDate}</p>
  {/if}
  {#if listing.apiKeyId}
    <p class="key-linked-note">
      <span class="chip linked">key linked</span>
    </p>
  {/if}
  <a
    class="cta-secondary store-link"
    href={steamUrl}
    target="_blank"
    rel="noopener noreferrer"
  >
    {m.steam_listing_open_in_steam()}
  </a>
  {#if gameId}
    <!-- Plan 02.1-39 round-6 polish #13: per-card Edit toggle (top-right
         corner). Click reveals the × Remove button on the same card,
         which opens the existing ConfirmDialog before DELETEing. Edit
         mode is per-card so destructive affordances stay localized. -->
    {#if !editing}
      <button
        type="button"
        class="edit-btn"
        aria-label={m.steam_listing_edit_aria()}
        onclick={() => (editing = true)}
      >
        {m.common_edit()}
      </button>
    {:else}
      <button
        type="button"
        class="remove-btn"
        aria-label={m.steam_listing_remove_aria()}
        onclick={() => (confirmOpen = true)}
        disabled={removing}
      >
        ×
      </button>
      <button
        type="button"
        class="cancel-edit-btn"
        onclick={() => (editing = false)}
      >
        {m.common_close()}
      </button>
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
  /* Plan 02.1-39 round-6 polish #13: in edit mode the Edit button is
   * REPLACED by a × Remove button + a Cancel button. Remove keeps the
   * destructive accent (matching ConfirmDialog flow); Cancel uses the
   * neutral edit-btn shape. */
  .remove-btn {
    position: absolute;
    top: var(--space-xs);
    right: calc(var(--space-xs) + 80px);
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--space-sm);
    background: var(--color-surface);
    color: var(--color-destructive);
    border: 1px solid var(--color-destructive);
    border-radius: 4px;
    font-size: var(--font-size-heading);
    line-height: 1;
    cursor: pointer;
    z-index: 1;
  }
  .remove-btn:hover:not(:disabled) {
    background: var(--color-destructive);
    color: #fff;
  }
  .remove-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cancel-edit-btn {
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
    cursor: pointer;
    z-index: 1;
  }
  .cancel-edit-btn:hover {
    background: rgb(0 0 0 / 80%);
  }
</style>

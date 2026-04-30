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
  // StoresSection's 3-per-row grid. Round-5 user quote: "Нужно сделать
  // игры карточками, как в feed. Нужен тип(стим) название, лейбл, дату
  // релиза и иконку на этой карточке, и кнопку быстро перейти в стим".
  // The card body renders, in order:
  //   - Header row: store-type icon (Steam glyph ▶) + store-side title
  //     (Steam game name from listing.metadata.steam.name; legacy
  //     fallback to `App {appId}`).
  //   - User label (from listing.label).
  //   - Release date (from listing.metadata.steam.releaseDate / persisted
  //     listing.releaseDate).
  //   - "Open in Steam" deep-link CTA → https://store.steampowered.com/app/{appId}/.
  //   - Optional × Remove button (only when editMode + gameId present).
  //
  // Item B (full Steam-listing edit form beyond label) is EXPLICITLY
  // DEFERRED to Phase 6 polish backlog per UAT-NOTES.md §5.3 framing —
  // requires a richer form component, not a 2.1 round-6 deliverable.
  //
  // displayName: prefer the persisted `name` (Plan 02.1-25 column added in
  // Task 1's migration 0004); fall back to m.steam_listing_unnamed() for
  // legacy rows (NULL `name`) or rows added during a Steam outage. The
  // fallback is graceful — users notice the metadata fetch failed without
  // breaking the flow.
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
    editMode = false,
    onChange,
  }: {
    listing: Listing;
    // gameId is OPTIONAL for backward compatibility with any callers that
    // render the row outside StoresSection. When omitted, the Remove button
    // hides (no DELETE target). StoresSection passes both editMode + gameId
    // so the Remove flow is fully wired on /games/[id].
    gameId?: string;
    editMode?: boolean;
    onChange?: () => void;
  } = $props();

  // Plan 02.1-39 (§5.3 item A): persisted listing.name flows through Plan
  // 02.1-25's column. The plan-time interface notes mentioned
  // listing.metadata?.steam?.name; the actual DTO surfaces a flat `name`
  // field. We honor `name` and fall back to the localized "Untitled" copy
  // so users see something readable even when the Steam fetch failed
  // (legacy `App {appId}` fallback retired — UAT user wanted human-readable
  // text, not opaque ids).
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
        onChange?.();
      }
    } finally {
      removing = false;
    }
  }
</script>

<article class="store-card">
  <header class="store-card-header">
    <!-- Plan 02.1-39 (UAT-NOTES.md §5.3 item A): store-type glyph at the
         top-left of the card. Decorative ▶ stand-in for the Steam logo;
         Phase 6 polish swaps for a real Steam SVG when the asset lands.
         aria-hidden because the textual label "Open in Steam" below
         carries the accessible name. -->
    <span class="store-icon" aria-hidden="true">▶</span>
    <h3 class="store-name">{displayName}</h3>
  </header>
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
  {#if editMode && gameId}
    <!-- Plan 02.1-30 (UAT-NOTES.md §4.25.H): Remove icon button — visible
         only when the page-level edit toggle is on. Mirrors SourceRow's
         edit-mode Remove pattern (Plan 02.1-22 §2.4). -->
    <button
      type="button"
      class="remove-btn"
      aria-label={m.steam_listing_remove_aria()}
      onclick={() => (confirmOpen = true)}
      disabled={removing}
    >
      ×
    </button>
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
   * inside the StoresSection grid. Replaces Plan 02.1-30's row layout. */
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
  }
  .store-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    min-width: 0;
  }
  .store-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--color-text-muted);
    font-size: var(--font-size-body);
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
  /* Plan 02.1-30 + Plan 02.1-39: Remove × button. In card layout the
   * button floats at the top-right corner of the card so it does not
   * compete with the user's reading flow inside the card body. 44×44 hit
   * area preserved per UI-SPEC §"Touch targets". */
  .remove-btn {
    position: absolute;
    top: var(--space-xs);
    right: var(--space-xs);
    min-width: 44px;
    min-height: 44px;
    padding: 0 var(--space-sm);
    background: transparent;
    color: var(--color-destructive);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-heading);
    line-height: 1;
    cursor: pointer;
  }
  .remove-btn:hover:not(:disabled) {
    border-color: var(--color-destructive);
  }
  .remove-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

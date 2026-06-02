<script lang="ts">
  // SteamListingRow — one read-only Steam listing card on /games/[id].
  //
  // The "advanced" affordances (label edit, remove, CSV import, full wishlist
  // summary, export instructions) ALL live in <SteamListingDetailModal>,
  // opened via the Details button. The card itself never mutates server state.
  //
  // displayName falls back to m.steam_listing_unnamed() for legacy rows (NULL
  // `name`) or rows added while Steam was unreachable at INSERT time.

  import { m } from "$lib/paraglide/messages.js";
  import SteamListingDetailModal from "./SteamListingDetailModal.svelte";
  import WishlistImport from "./WishlistImport.svelte";
  import { wishlistAgo } from "$lib/util/wishlist-ago.js";
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
    listing,
    gameId,
    summary = null,
    trash = false,
    onChange,
    onRestore,
    onDeleteForever,
  }: {
    listing: Listing;
    // gameId is OPTIONAL for backward compatibility with any callers that
    // render the row outside StoresSection. When omitted, the Details
    // affordance hides (no mutation target).
    gameId?: string;
    // This listing's wishlist mini-summary from the loader's
    // wishlistSummaries map. null = no snapshots yet (empty state).
    summary?: WishlistSummaryDto | null;
    // Trash mode: the card is read-only — no Details button, no wishlist
    // line, no edit. A ⋮ overflow offers Restore + Delete forever. The parent
    // page owns the mutation handlers + ConfirmDialog.
    trash?: boolean;
    onChange?: () => void;
    onRestore?: () => void;
    onDeleteForever?: () => void;
  } = $props();

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);

  // Compact wishlist line uses the shared wishlistAgo bucketing helper
  // (just-now / N minutes / N hours / N days), routed through m.* (i18n).
  const compactWishlist = $derived(
    summary && summary.recentDays.length > 0
      ? m.steam_listing_wishlist_compact({
          balance: summary.balance.toLocaleString("en"),
          ago: wishlistAgo(summary.recentDays[0]!.updatedAt),
        })
      : null,
  );

  let detailOpen = $state(false);

  // Trash-mode overflow menu (EventDetailHeader idiom — Restore + Delete
  // forever as menu items).
  let trashMenuOpen = $state(false);

  // Escape closes the trash overflow menu (keyboard parity with the scrim
  // click). The <svelte:window> listener is top-level (Svelte requires it
  // there); the handler no-ops unless the menu is open.
  function onTrashMenuKeydown(e: KeyboardEvent): void {
    if (trashMenuOpen && e.key === "Escape") {
      trashMenuOpen = false;
    }
  }
</script>

<svelte:window onkeydown={onTrashMenuKeydown} />

<article class="store-card" class:trash>
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
    <span class="kind-badge" data-kind="steam">{m.steam_listing_kind_steam()}</span>
    <h3 class="store-name">{displayName}</h3>
  </header>
  <p class="app-id">{m.steam_listing_app_id({ appId: listing.appId })}</p>
  {#if listing.label}
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

  {#if trash}
    <!-- Trash mode: read-only card with a ⋮ overflow (Restore + Delete
         forever). No wishlist line, no Details/edit affordances. -->
    <div class="card-actions">
      <a class="cta-secondary store-link" href={steamUrl} target="_blank" rel="noopener noreferrer">
        {m.steam_listing_open_in_steam()}
      </a>
      <div class="trash-overflow-wrap">
        <button
          type="button"
          class="cta-secondary trash-overflow-btn"
          onclick={() => (trashMenuOpen = !trashMenuOpen)}
          aria-haspopup="menu"
          aria-expanded={trashMenuOpen}
          aria-label={m.steam_listing_more_actions_aria()}
          title={m.steam_listing_more_actions_aria()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="19" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </button>
        {#if trashMenuOpen}
          <button
            type="button"
            class="trash-overflow-scrim"
            aria-label={m.common_close()}
            onclick={() => (trashMenuOpen = false)}
          ></button>
          <div class="trash-overflow-pop" role="menu">
            <button
              type="button"
              class="card-menu-item"
              role="menuitem"
              onclick={() => {
                trashMenuOpen = false;
                onRestore?.();
              }}>{m.common_restore()}</button
            >
            <button
              type="button"
              class="card-menu-item danger"
              role="menuitem"
              onclick={() => {
                trashMenuOpen = false;
                onDeleteForever?.();
              }}>{m.steam_listing_delete_forever_cta()}</button
            >
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Compact wishlist line. Data when a summary exists; otherwise a short
         recommendation. A small muted "↑ CSV" link at the end imports a
         wishlist CSV in one click (compact WishlistImport) — the line
         refreshes via onChange on success. A <div> (not <p>) so the
         compact-error line nests cleanly. -->
    <div class="wishlist-line" class:muted={!compactWishlist}>
      <span class="wishlist-text">
        {compactWishlist ?? m.steam_listing_wishlist_recommendation()}
      </span>
      {#if gameId}
        <WishlistImport {gameId} listingId={listing.id} compact onImported={() => onChange?.()} />
      {/if}
    </div>

    <div class="card-actions">
      <a class="cta-secondary store-link" href={steamUrl} target="_blank" rel="noopener noreferrer">
        {m.steam_listing_open_in_steam()}
      </a>
      {#if gameId}
        <button type="button" class="cta-secondary details-btn" onclick={() => (detailOpen = true)}>
          {m.steam_listing_details_cta()}
        </button>
      {/if}
    </div>
  {/if}
</article>

{#if gameId && !trash}
  <SteamListingDetailModal
    open={detailOpen}
    {gameId}
    {listing}
    {summary}
    onClose={() => (detailOpen = false)}
    {onChange}
  />
{/if}

<style>
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
  /* Trash cards carry a ⋮ overflow menu that opens BELOW the button; the
   * card's `overflow: hidden` (there for the cover bleed) would clip it, so
   * trash cards switch to `overflow: visible` and round the cover's top
   * corners directly instead of relying on the card clip. */
  .store-card.trash {
    overflow: visible;
  }
  .store-card.trash .store-cover {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
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
  /* Compact wishlist line — single-row summary or a muted recommendation,
   * plus a small muted "↑ CSV" import link at the end. Flex so the link
   * sits inline at the end and an import error (flex-basis: 100%) wraps to
   * its own line below. */
  .wishlist-line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--s-2);
    margin: 0;
  }
  .wishlist-text {
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    min-width: 0;
  }
  .wishlist-line.muted .wishlist-text {
    color: var(--text-3);
    font-weight: var(--w-rg);
  }
  .card-actions {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    margin-top: var(--s-1);
  }
  .cta-secondary {
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
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta-secondary:hover {
    background: var(--accent);
    color: var(--accent-text);
  }
  /* ── Trash-mode overflow (EventDetailHeader idiom) ──────────────────── */
  .trash-overflow-wrap {
    position: relative;
  }
  .trash-overflow-btn {
    padding: var(--s-1) var(--s-2);
  }
  .trash-overflow-scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
  }
  .trash-overflow-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 160px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex;
    flex-direction: column;
    z-index: 90;
  }
  .trash-overflow-pop .card-menu-item {
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
  .trash-overflow-pop .card-menu-item:hover {
    background: var(--accent-soft);
  }
  .trash-overflow-pop .card-menu-item.danger {
    color: var(--danger);
  }
  .trash-overflow-pop .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
  }
  @media (prefers-reduced-motion: reduce) {
    .cta-secondary {
      transition: none;
    }
  }
</style>

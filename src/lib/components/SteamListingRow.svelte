<script lang="ts">
  // SteamListingRow — one Steam listing card on /games/[id].
  //
  // The ACTIVE card is a clickable card (BaseFeedCard idiom): the whole card
  // is a role="button" surface that opens <SteamListingDetailModal> on
  // click / Enter / Space. Inner interactive controls (the small "Open in
  // Steam" external link + the compact "↑ CSV" import) call
  // e.stopPropagation() so they don't trigger the card→modal open. The
  // "advanced" affordances (label edit, remove, full wishlist summary, export
  // instructions) ALL live in the modal — the card itself never mutates
  // server state.
  //
  // The TRASH card stays read-only and is NOT clickable-to-modal: it carries
  // a ⋮ overflow (Restore + Delete forever) instead.
  //
  // displayName falls back to m.steam_listing_unnamed() for legacy rows (NULL
  // `name`) or rows added while Steam was unreachable at INSERT time.

  import { m } from "$lib/paraglide/messages.js";
  import { relativeDate } from "$lib/util/relative-date.js";
  import SteamListingDetailModal from "./SteamListingDetailModal.svelte";
  import WishlistImport from "./WishlistImport.svelte";
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
    // render the row outside StoresSection. When omitted, the card click +
    // detail modal hide (no mutation target).
    gameId?: string;
    // This listing's wishlist mini-summary from the loader's
    // wishlistSummaries map. null = no snapshots yet (empty state).
    summary?: WishlistSummaryDto | null;
    // Trash mode: the card is read-only — not clickable-to-modal, no wishlist
    // line. A ⋮ overflow offers Restore + Delete forever. The parent page owns
    // the mutation handlers + ConfirmDialog.
    trash?: boolean;
    onChange?: () => void;
    onRestore?: () => void;
    onDeleteForever?: () => void;
  } = $props();

  const displayName = $derived(listing.name ?? m.steam_listing_unnamed());
  const steamUrl = $derived(`https://store.steampowered.com/app/${listing.appId}/`);

  // Compact wishlist line: balance + how RECENT the data is, as a human
  // relative label ("as of yesterday") rather than a raw ISO date or the
  // import timestamp (which misled — importing yesterday's data read "just
  // now"). The exact first→last range lives in the Details modal + the line's
  // title tooltip.
  const compactWishlist = $derived(
    summary && summary.recentDays.length > 0
      ? m.steam_listing_wishlist_compact({
          balance: summary.balance.toLocaleString("en"),
          when: relativeDate(summary.lastDate),
        })
      : null,
  );

  // Exact coverage for the line's hover title: a single day, or first → last.
  const coverageTitle = $derived(
    summary && summary.recentDays.length > 0
      ? summary.firstDate === summary.lastDate
        ? summary.firstDate
        : `${summary.firstDate} → ${summary.lastDate}`
      : null,
  );

  let detailOpen = $state(false);

  // Active card is clickable only when a mutation target (gameId) exists and
  // we're not in trash mode — that's also the only case the detail modal is
  // mounted.
  const cardClickable = $derived(!trash && gameId !== undefined);

  // Card → modal open. Ignore clicks that originate inside an inner
  // interactive control (the Open-in-Steam link, the compact import) — those
  // stopPropagation() themselves, but the closest() guard is the belt-and-
  // suspenders match used by BaseFeedCard.
  function openDetail(e: Event): void {
    if (!cardClickable) return;
    const target = e.target as Element;
    if (target.closest(".store-link, .wishlist-line, .card-actions")) return;
    detailOpen = true;
  }

  function onCardKeydown(e: KeyboardEvent): void {
    if (!cardClickable) return;
    if (e.key === "Enter" || e.key === " ") {
      const target = e.target as Element;
      if (target.closest(".store-link, .wishlist-line, .card-actions")) return;
      e.preventDefault();
      detailOpen = true;
    }
  }

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

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role, a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<article
  class="store-card"
  class:trash
  class:clickable={cardClickable}
  role={cardClickable ? "button" : undefined}
  tabindex={cardClickable ? 0 : undefined}
  aria-label={cardClickable ? m.steam_listing_open_details_aria({ name: displayName }) : undefined}
  onclick={cardClickable ? openDetail : undefined}
  onkeydown={cardClickable ? onCardKeydown : undefined}
>
  {#if listing.coverUrl}
    <!-- Cover image at the top of the card. The Steam header image
         dimensions are 460×215 (~2.14:1); the CSS aspect-ratio keeps the
         image proportional even if Steam returns a different size in
         the future. The Steam logo sits as a small scrim chip over the
         cover (top-left), mirroring BaseFeedCard's kind-icon overlay. -->
    <div class="cover-wrap">
      <img
        class="store-cover"
        src={listing.coverUrl}
        alt={m.steam_listing_cover_alt({ name: displayName })}
        loading="lazy"
      />
      <span class="kind-icon kind-icon--overlay" aria-label={m.steam_listing_kind_steam()}>
        {@render steamLogo()}
      </span>
    </div>
  {/if}
  <header class="store-card-header">
    {#if !listing.coverUrl}
      <!-- No cover image → the Steam indicator falls back into the header
           row next to the name. -->
      <span class="kind-icon" aria-label={m.steam_listing_kind_steam()}>
        {@render steamLogo()}
      </span>
    {/if}
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
         forever). No wishlist line, no clickable-to-modal. -->
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
         compact-error line nests cleanly. The whole line stops click
         propagation so the inner import button / error never bubble to the
         card→modal open. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="wishlist-line"
      class:muted={!compactWishlist}
      title={coverageTitle}
      onclick={(e) => e.stopPropagation()}
    >
      <span class="wishlist-text">
        {compactWishlist ?? m.steam_listing_wishlist_recommendation()}
      </span>
      {#if gameId}
        <WishlistImport {gameId} listingId={listing.id} compact onImported={() => onChange?.()} />
      {/if}
    </div>

    <div class="card-actions">
      <!-- Small muted external link — INDICATOR-distinct from the card open.
           stopPropagation so clicking it doesn't also open the detail modal. -->
      <a
        class="store-link"
        href={steamUrl}
        target="_blank"
        rel="noopener noreferrer"
        onclick={(e) => e.stopPropagation()}
      >
        {m.steam_listing_open_in_steam()}
      </a>
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

{#snippet steamLogo()}
  <!-- Monochrome Steam logo (currentColor). Recognizable Steam mark: the
       outer circle + the inner "pipe/bomb" glyph. INDICATOR only. -->
  <svg
    width="16"
    height="16"
    viewBox="0 0 256 259"
    fill="currentColor"
    aria-hidden="true"
    role="presentation"
  >
    <path
      d="M127.778 0C60.42 0 5.24 52.412 0 119.014l68.724 28.674a36.05 36.05 0 0 1 20.426-6.366c.682 0 1.356.018 2.02.05l30.566-44.71v-.626c0-26.903 21.69-48.79 48.354-48.79 26.665 0 48.355 21.887 48.355 48.79 0 26.902-21.69 48.798-48.355 48.798-.37 0-.73-.009-1.094-.018l-43.593 31.377c.022.582.04 1.164.04 1.746 0 20.204-16.29 36.64-36.314 36.64-17.573 0-32.27-12.66-35.604-29.4L4.518 164.13c15.177 54.137 64.296 93.82 122.66 93.82 70.495 0 127.661-57.683 127.661-128.83C254.84 57.974 197.673 0 127.778 0z"
    />
    <path
      d="M80.05 195.674l-15.68-6.532c2.778 5.823 7.59 10.696 13.99 13.4 13.83 5.835 29.85-.768 35.642-14.71a27.58 27.58 0 0 0 .02-21.115c-2.737-6.566-7.847-11.69-14.4-14.434-6.5-2.722-13.44-2.62-19.518-.41l16.2 6.745c10.2 4.302 15.014 16.118 10.752 26.404-4.262 10.285-15.99 15.136-26.19 10.835l-.804-.337-.012-.001zm127.522-99.66c0-17.916-14.443-32.49-32.196-32.49-17.756 0-32.2 14.574-32.2 32.49 0 17.92 14.444 32.485 32.2 32.485 17.753 0 32.196-14.565 32.196-32.485zm-56.318-.054c0-13.456 10.836-24.367 24.2-24.367 13.37 0 24.207 10.91 24.207 24.367 0 13.46-10.838 24.37-24.206 24.37-13.365 0-24.2-10.91-24.2-24.37z"
    />
  </svg>
{/snippet}

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
    transition:
      border-color var(--m-fast) var(--m-ease),
      background var(--m-fast) var(--m-ease);
  }
  /* Active (clickable) card mirrors the BaseFeedCard affordance — accent
   * border + pointer cursor on hover, accent focus ring for keyboard. */
  .store-card.clickable {
    cursor: pointer;
  }
  @media (hover: hover) {
    .store-card.clickable:hover {
      border-color: var(--accent);
      background: var(--surface-3);
    }
  }
  .store-card.clickable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Trash cards carry a ⋮ overflow menu that opens BELOW the button; the
   * card's `overflow: hidden` (there for the cover bleed) would clip it, so
   * trash cards switch to `overflow: visible` and round the cover's top
   * corners directly instead of relying on the card clip. */
  .store-card.trash {
    overflow: visible;
  }
  .store-card.trash .cover-wrap,
  .store-card.trash .store-cover {
    border-top-left-radius: var(--r-md);
    border-top-right-radius: var(--r-md);
  }
  /* Cover wrapper bleeds to the card edge so the image frames cleanly; the
   * Steam logo overlay is absolute-positioned relative to it. */
  .cover-wrap {
    position: relative;
    width: calc(100% + 2 * var(--s-4));
    margin-top: calc(var(--s-4) * -1);
    margin-left: calc(var(--s-4) * -1);
    margin-right: calc(var(--s-4) * -1);
  }
  /* Cover image at the top of the card. Aspect ratio matches Steam's
   * standard header image (460×215). */
  .store-cover {
    display: block;
    width: 100%;
    aspect-ratio: 460 / 215;
    object-fit: cover;
    background: var(--surface-3);
  }
  /* Steam indicator. In the header (no-cover fallback) it inherits the muted
   * text color; over the cover it sits on a dark scrim chip for legibility. */
  .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .kind-icon--overlay {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 4px;
    background: var(--overlay-dark);
    color: #fff;
    border-radius: var(--r-sm);
    line-height: 0;
  }
  .store-card-header {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    flex-wrap: wrap;
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
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    margin-top: var(--s-1);
  }
  /* Small muted "Open in Steam" external link — inline text affordance, NOT
   * a button. Reads as a secondary link so the card-open is the primary
   * action. */
  .store-link {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    text-decoration: none;
    cursor: pointer;
    transition: color var(--m-fast) var(--m-ease);
  }
  .store-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  /* Trash mode keeps the bordered secondary-CTA treatment for its links +
   * overflow button (the trash card is not a clickable surface, so the link
   * stays a prominent affordance). */
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
    .store-card,
    .cta-secondary,
    .store-link {
      transition: none;
    }
  }
</style>

<script lang="ts">
  // StoresSection — /games/[id] stores section body. Pure list renderer:
  // the parent page owns the Add lifecycle (an Add button next to the
  // Stores heading opens <AddStoreDialog> as a modal). The section header
  // (`Магазины` h2) lives on the parent page.
  //
  // Layout grid: listings flow in a CSS grid (`auto-fill, minmax(260px,
  // 1fr)`) — 3-per-row at >=900px, single column at 360px.
  //
  // Steam-only today. Itch + Epic are explicitly deferred (no platform
  // selector). When more stores land, promote AddSteamListingForm to a
  // per-platform sub-form and add a platform picker above it.

  import { m } from "$lib/paraglide/messages.js";
  import SteamListingRow from "./SteamListingRow.svelte";
  import type { GameSteamListingDto, WishlistSummaryDto } from "$lib/server/dto.js";

  let {
    listings,
    gameId,
    wishlistSummaries = {},
    onChange,
  }: {
    listings: GameSteamListingDto[];
    gameId: string;
    // Per-listing wishlist summaries keyed by listing id (from the loader).
    wishlistSummaries?: Record<string, WishlistSummaryDto | null>;
    onChange: () => void;
  } = $props();
</script>

<div class="stores-body">
  {#if listings.length === 0}
    <p class="muted">{m.stores_empty()}</p>
  {/if}

  {#if listings.length > 0}
    <ul class="stores-grid">
      {#each listings as listing (listing.id)}
        <li>
          <SteamListingRow
            {listing}
            {gameId}
            summary={wishlistSummaries[listing.id] ?? null}
            {onChange}
          />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* v2 StoresSection — simple wrapper. Grid layout for the listings.
   * Padding around --surface-2 cards is owned by SteamListingRow. */
  .stores-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    min-width: 0;
  }
  /* Grid layout. 3 cards per row at >=900px; 2-per-row in the
   * 600-900 band; single column at 360px (auto-fill collapses naturally
   * below 260px + gutter). */
  .stores-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--s-3);
  }
  .muted {
    margin: 0;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
</style>

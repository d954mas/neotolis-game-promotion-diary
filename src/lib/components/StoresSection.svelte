<script lang="ts">
  // StoresSection — /games/[id] stores section body (Plan 02.1-30; Plan
  // 02.1-39 round-6 grid layout; Plan 02.1-39 round-6 polish #13 layout
  // restructure; Plan 02.1-39 round-6 polish #14c list-only refactor).
  //
  // Plan 02.1-30 created the section-header + listings-list pattern. Plan
  // 02.1-39 §5.3 RELOCATED the section-header (`Магазины` h2) up to the
  // parent page, leaving this component to render the listings body.
  //
  // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13)
  // moved the Add CTA from above the grid to AFTER the grid (`.add-row`
  // block) per user direction "добавление давай сделаем внизу после
  // карточек сторов". The form expanded inline on the page.
  //
  // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14,
  // 2026-04-30): user surfaced a reversal during round-6 UAT after
  // polish #13 landed (verbatim, ru):
  //   "сейчас добавление стора сделано полями на этой странице. Я хочу
  //    через кнопку add рядом с заголовкот Stores"
  //   ("right now adding a store is done with fields on the page. I
  //    want it via an Add button next to the Stores heading.")
  //
  // The add-affordance moves AGAIN: this time back next to the Stores
  // h2 (where polish #13 had moved it AWAY from), but the click now
  // opens an <AddStoreDialog> modal instead of expanding the form
  // inline on the page. StoresSection consequently becomes a pure list
  // renderer — no add-form state, no Add CTA, no inline form. The
  // parent page owns the Add lifecycle.
  //
  // Layout grid (unchanged from §5.3 item A/D — round-5 user direction):
  // listings flow in a CSS grid (`auto-fill, minmax(260px, 1fr)`) — 3-per-
  // row at >=900px, single column at 360px.
  //
  // Phase 2.1 ships Steam-only behind the new shell. Per CONTEXT.md +
  // UAT-NOTES.md §4.25.C, Itch + Epic are explicitly DEFERRED (no platform
  // selector). Phase 3+ promotes AddSteamListingForm to a per-platform
  // sub-form and adds a platform picker above it.

  import { m } from "$lib/paraglide/messages.js";
  import SteamListingRow from "./SteamListingRow.svelte";
  import type { GameSteamListingDto } from "$lib/server/dto.js";

  let {
    listings,
    gameId,
    onChange,
  }: {
    listings: GameSteamListingDto[];
    gameId: string;
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
          <SteamListingRow {listing} {gameId} {onChange} />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .stores-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  /* Plan 02.1-39 (UAT-NOTES.md §5.3 item A/D): grid layout. 3 cards per
   * row at >=900px (3 * 260 + 2 * 16 = 812px content; fits at 900px
   * including page padding); 2-per-row in the 600-900 band; single column
   * at 360px (auto-fill collapses naturally below 260px + gutter). */
  .stores-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-md);
  }
  .muted {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
</style>

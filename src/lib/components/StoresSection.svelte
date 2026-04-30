<script lang="ts">
  // StoresSection — /games/[id] stores section body (Plan 02.1-30; Plan
  // 02.1-39 round-6 grid layout; Plan 02.1-39 round-6 polish #13 layout
  // restructure).
  //
  // Plan 02.1-30 created the section-header + listings-list pattern. Plan
  // 02.1-39 §5.3 RELOCATED the section-header (`Магазины` h2 + Edit toggle
  // + Add CTA) up to the parent page, leaving this component to render
  // ONLY the listings body — the grid + an inline + Add affordance.
  //
  // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  // 2026-04-30): the user surfaced two layout changes during round-6 UAT:
  //
  //   "Stores. Там добавление давай сделаем внизу после карточек сторов."
  //   ("Stores. Add should go at the bottom after the store cards.")
  //
  //   "На картчоке стора нужно имя, и картинка из стора. app id и
  //    обозначить стор(стим, итч)"
  //   ("Each store card needs the name, the image from the store, the
  //    app id, and a store-type marker (Steam, Itch).")
  //
  //   "кнопка edit она у каждой карточки стора, мелко и отдельно"
  //   ("the Edit button is on each store card, small and separate")
  //
  // What changes in this component:
  //   1. The Add CTA moves from above the grid (the old `.actions-row`)
  //      to AFTER the grid (a new `.add-row` block) so the natural read
  //      order is "see the cards → tap Add to register a new store".
  //   2. The `editMode` prop is RETIRED — each <SteamListingRow> owns
  //      its own per-card edit-mode now, surfaced by a small per-card
  //      Edit button (round-6 polish #13). The parent page no longer
  //      passes editMode at all.
  //   3. The CTA is restyled as a secondary button at the bottom of the
  //      section so it does not compete visually with the cards.
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
  import AddSteamListingForm from "./AddSteamListingForm.svelte";
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

  let showAddForm = $state(false);
</script>

<div class="stores-body">
  {#if listings.length === 0 && !showAddForm}
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

  {#if showAddForm}
    <!-- Phase 2.1 ships Steam-only. Phase 3+ adds platform selector +
         per-platform sub-forms. Per CONTEXT.md / UAT-NOTES.md §4.25.C:
         Itch + Epic deferred. -->
    <AddSteamListingForm
      {gameId}
      onSuccess={() => {
        showAddForm = false;
        onChange();
      }}
    />
  {/if}

  <!-- Plan 02.1-39 round-6 polish #13: the Add CTA sits at the BOTTOM of
       the section (after the grid + the active form, if any). User
       direction: "добавление давай сделаем внизу после карточек сторов".
       Hidden while the form is open so we don't show a redundant button
       above its own form. -->
  {#if !showAddForm}
    <div class="add-row">
      <button
        type="button"
        class="cta-secondary add-store"
        onclick={() => (showAddForm = true)}
      >
        {m.stores_add_cta_after_cards()}
      </button>
    </div>
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
  /* Plan 02.1-39 round-6 polish #13: the Add CTA at the BOTTOM of the
   * section is styled as a secondary button (not the primary accent
   * background) so it visually subordinates to the cards above. The
   * row container left-aligns the button so on wide viewports it sits
   * under the first column rather than stretching across all three. */
  .add-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }
  .cta-secondary.add-store {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-accent);
    border: 1px dashed var(--color-accent);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cta-secondary.add-store:hover {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border-style: solid;
  }
</style>

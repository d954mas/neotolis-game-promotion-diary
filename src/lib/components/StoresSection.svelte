<script lang="ts">
  // StoresSection — /games/[id] stores section body (Plan 02.1-30; Plan
  // 02.1-39 round-6 grid layout).
  //
  // Plan 02.1-30 created the section-header + listings-list pattern. Plan
  // 02.1-39 (UAT-NOTES.md §5.3 item A/D/E) RELOCATES the section-header
  // (`Магазины` h2 + Edit toggle + Add CTA) UP to the parent
  // /games/[gameId]/+page.svelte so all three sections (Игра / Магазины /
  // Лента) share the same `.section-header` row pattern. This component
  // now owns ONLY the listings body — the grid + the inline + Add form
  // toggle (revealed by the user clicking the parent's section-header
  // Edit button OR the parent's "+ Add" CTA).
  //
  // Layout change (Plan 02.1-39 §5.3 item A/D): listings flow in a CSS
  // grid (`auto-fill, minmax(260px, 1fr)`) so cards lay out 3-per-row at
  // >=900px and fall back to single-column at 360px. Round-5 user quote:
  // "Сторы(карточки, 3 в ряд как в feed)".
  //
  // Phase 2.1 ships Steam-only behind the new shell. Per CONTEXT.md +
  // UAT-NOTES.md §4.25.C, Itch + Epic are explicitly DEFERRED (no platform
  // selector). Phase 3+ promotes AddSteamListingForm to a per-platform
  // sub-form and adds a platform picker above it.
  //
  // The page-level `editMode` toggle drives SteamListingRow's Remove icon
  // visibility (mirror of SourceRow's edit pattern from Plan 02.1-22).
  // Plan 02.1-39 — the parent wires editMode to its `editingStores` scope
  // so the Magazины Edit toggle is the only thing that flips Remove ×
  // visibility. `onChange` is called after a successful add or remove so
  // the parent can `invalidateAll()` and the page loader re-runs.

  import { m } from "$lib/paraglide/messages.js";
  import SteamListingRow from "./SteamListingRow.svelte";
  import AddSteamListingForm from "./AddSteamListingForm.svelte";
  import type { GameSteamListingDto } from "$lib/server/dto.js";

  let {
    listings,
    gameId,
    editMode,
    onChange,
  }: {
    listings: GameSteamListingDto[];
    gameId: string;
    editMode: boolean;
    onChange: () => void;
  } = $props();

  let showAddForm = $state(false);
</script>

<div class="stores-body">
  <!-- Plan 02.1-39 (UAT-NOTES.md §5.3 item C/E): the section header
       (h2 "Магазины" + Edit toggle + + Add CTA) lives in the parent
       page; this component renders only the listings grid + the
       AddSteamListingForm toggle. The "+ Add" affordance stays here as
       a small inline button so users can reveal the form without
       leaving the section; the parent's section-header CTA also flips
       this state via the editMode toggle path (Phase 6 polish — for
       now both buttons coexist; the parent CTA is the discoverable
       entry per UAT user direction). -->
  <div class="actions-row">
    <button
      type="button"
      class="cta"
      onclick={() => (showAddForm = !showAddForm)}
    >
      + {m.stores_add_cta()}
    </button>
  </div>

  {#if listings.length === 0 && !showAddForm}
    <p class="muted">{m.stores_empty()}</p>
  {/if}

  {#if listings.length > 0}
    <ul class="stores-grid">
      {#each listings as listing (listing.id)}
        <li>
          <SteamListingRow {listing} {gameId} {editMode} {onChange} />
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
</div>

<style>
  .stores-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .actions-row {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
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
  .cta {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cta:hover {
    opacity: 0.9;
  }
</style>

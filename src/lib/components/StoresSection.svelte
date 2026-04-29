<script lang="ts">
  // StoresSection — /games/[id] stores section wrapper (Plan 02.1-30,
  // UAT-NOTES.md §4.25.C closure).
  //
  // Replaces the inline `<h2>Store listings</h2>` + `<ul class='listings'>`
  // + `<AddSteamListingForm>` block from Plan 02.1-25 with a single section
  // header (`Магазины / Stores`) + `+ Добавить` CTA + listings list +
  // collapsible AddSteamListingForm body.
  //
  // Phase 2.1 ships Steam-only behind the new shell. Per CONTEXT.md +
  // UAT-NOTES.md §4.25.C, Itch + Epic are explicitly DEFERRED (no platform
  // selector). Phase 3+ promotes AddSteamListingForm to a per-platform
  // sub-form and adds a platform picker above it.
  //
  // The page-level `editMode` toggle drives SteamListingRow's Remove icon
  // visibility (mirror of SourceRow's edit pattern from Plan 02.1-22).
  // `onChange` is called after a successful add or remove so the parent
  // can `invalidateAll()` and the page loader re-runs.

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

<section class="stores">
  <header class="stores-header">
    <h2 class="stores-heading">{m.stores_section_heading()}</h2>
    <button
      type="button"
      class="cta"
      onclick={() => (showAddForm = !showAddForm)}
    >
      + {m.stores_add_cta()}
    </button>
  </header>

  {#if listings.length === 0 && !showAddForm}
    <p class="muted">{m.stores_empty()}</p>
  {/if}

  {#if listings.length > 0}
    <ul class="listings">
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
</section>

<style>
  .stores {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .stores-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
    min-width: 0;
  }
  .stores-heading {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
  }
  .listings {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
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

<script lang="ts">
  // ActiveFiltersStrip — Wave 2a (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 200-256. Renders the
  // chip strip showing which filters are currently active when the
  // <PageHead>'s Filters panel is COLLAPSED (LB-10 toggle). Each chip
  // dismisses one specific filter via its onRemove callback; "Clear all"
  // dismisses everything in one click.
  //
  // Placement decision (RESEARCH Open Question 4): this strip lives
  // BELOW PageHead, not inside the sticky chrome. PageHead measures its
  // own height (LB-3 ResizeObserver) and publishes
  // --page-header-height; if the strip were inside PageHead it would
  // grow that height every time a filter chip was added, knocking the
  // sticky FeedDateGroupHeader's `top:` math out of sync. By rendering
  // OUTSIDE the sticky wrapper we preserve the stable-height contract.
  //
  // Component is presentational — the caller assembles the AxisChip[]
  // array from FilterState and provides onRemove / onClearAll wiring
  // (which themselves walk through `serializeFilterState` to update the
  // URL).

  import { m } from "$lib/paraglide/messages.js";

  export type AxisChip = {
    // Discriminates the chip's color treatment (kind / game / author /
    // show / source — each may get an accent in a later sub-task).
    axis: "show" | "game" | "kind" | "source" | "author";
    label: string;
    onRemove: () => void;
  };

  let {
    axes,
    onClearAll,
  }: {
    axes: AxisChip[];
    onClearAll: () => void;
  } = $props();

  let visible = $derived(axes.length > 0);
</script>

{#if visible}
  <div class="active-filters" role="status" aria-label="Active filters">
    {#each axes as chip (chip.axis + ":" + chip.label)}
      <button
        type="button"
        class="chip"
        data-axis={chip.axis}
        data-active="1"
        onclick={chip.onRemove}
        aria-label={m.feed_active_filters_remove_aria({ label: chip.label })}
      >
        <span>{chip.label}</span>
        <span class="x" aria-hidden="true">×</span>
      </button>
    {/each}
    <button type="button" class="clear-all" onclick={onClearAll}>
      {m.feed_active_filters_clear_all()}
    </button>
  </div>
{/if}

<style>
  .active-filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-4);
    background: transparent;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-pill);
    padding: var(--s-1) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .chip:hover {
    background: var(--accent);
    color: var(--accent-text);
  }
  .chip .x {
    color: inherit;
    font-size: 14px;
    line-height: 1;
    margin-left: 2px;
  }

  .clear-all {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-3);
    border-radius: var(--r-pill);
    padding: var(--s-1) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    cursor: pointer;
    transition:
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .clear-all:hover {
    color: var(--danger);
    border-color: var(--danger);
  }

  @media (prefers-reduced-motion: reduce) {
    .chip,
    .clear-all {
      transition: none;
    }
  }
</style>

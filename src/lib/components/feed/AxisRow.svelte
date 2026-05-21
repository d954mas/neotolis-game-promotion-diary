<script lang="ts">
  // AxisRow — Wave 2a generic per-axis filter row (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 260-305. Renders one
  // filter axis (show / game / kind / source / author) as a label +
  // horizontal chip strip. Each chip shows the option's user-facing
  // label AND a predicted-count tail computed by the caller via
  // filter-math.countWith* (so the user sees "Reddit (12)" — clicking
  // restricts to that 12-event subset).
  //
  // Multi-select semantics: every selected chip toggles its
  // membership in `selectedValues`. The optional × button at the end
  // clears the entire axis (only rendered when at least one chip is
  // selected). Visual states:
  //   - data-active="1"   chip is in the active selection
  //   - data-zero="1"     count tail is 0 (visually muted, but the chip
  //                       remains clickable so the user can still pick
  //                       a zero-result axis — empty result is a valid
  //                       outcome, not an error)
  //
  // Single-select axes (show, author) emulate radio behavior at the
  // caller level — the caller passes `selectedValues` as a 0- or
  // 1-element array; clicking a different option replaces the selection
  // in one step (the caller computes the next-state at toggle time).

  import { m } from "$lib/paraglide/messages.js";

  let {
    label,
    axisKey,
    options,
    selectedValues,
    onToggle,
    onClearAxis,
  }: {
    label: string;
    axisKey: "show" | "game" | "kind" | "source" | "author";
    options: Array<{ value: string; label: string; predictedCount: number }>;
    selectedValues: string[];
    onToggle: (value: string) => void;
    onClearAxis: () => void;
  } = $props();

  let hasSelection = $derived(selectedValues.length > 0);
</script>

<div class="axis-row" data-axis={axisKey}>
  <div class="axis-label">{label}</div>
  <div class="axis-chips">
    {#each options as opt (opt.value)}
      {@const active = selectedValues.includes(opt.value)}
      <button
        type="button"
        class="chip"
        data-active={active ? "1" : "0"}
        data-axis={axisKey}
        data-key={opt.value}
        onclick={() => onToggle(opt.value)}
      >
        <span>{opt.label}</span>
        <span
          class="count"
          data-zero={opt.predictedCount === 0 ? "1" : "0"}
        >{opt.predictedCount}</span>
      </button>
    {/each}
  </div>
  {#if hasSelection}
    <button
      type="button"
      class="clear-axis"
      aria-label={m.axis_row_clear_axis_aria({ axis: label })}
      onclick={onClearAxis}
    >×</button>
  {/if}
</div>

<style>
  .axis-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    min-width: 0;
  }

  .axis-label {
    flex-shrink: 0;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    color: var(--text-3);
    font-weight: var(--w-sb);
    min-width: 60px;
  }

  .axis-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    flex: 1;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-1) var(--s-2);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .chip:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .chip[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
    font-weight: var(--w-sb);
  }

  .count {
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    font-size: var(--t-12);
  }
  .count[data-zero="1"] {
    opacity: 0.5;
  }
  .chip[data-active="1"] .count {
    color: var(--accent);
    opacity: 0.85;
  }

  .clear-axis {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
    padding: 0 var(--s-1);
    flex-shrink: 0;
    transition: color var(--m-fast) var(--m-ease);
  }
  .clear-axis:hover {
    color: var(--danger);
  }

  @media (prefers-reduced-motion: reduce) {
    .chip,
    .clear-axis {
      transition: none;
    }
  }
</style>

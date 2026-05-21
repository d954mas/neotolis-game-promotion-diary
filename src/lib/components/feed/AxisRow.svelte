<script lang="ts">
  // AxisRow — Wave 2a generic per-axis filter row (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 260-305 + index.html
  // `.axis-row` / `.chip.axis-chip` / `.axis-chip-count` CSS rules
  // (index.html lines 628-708).
  //
  // Renders one filter axis (show / game / kind / source / author) as a
  // label + horizontal chip strip. Each chip shows the option's
  // user-facing label AND a predicted-count tail badge computed by the
  // caller via filter-math.countWith* (so the user sees "Reddit (12)").
  //
  // Visual contract vs. the prototype:
  //   - Label: 10.5px uppercase tracked text-3 in a fixed 76px column
  //     (CSS grid). Stacks above on narrow viewports (<720px).
  //   - Chip default: transparent bg, transparent border, text-2 color —
  //     reads as a "soft tab" not a "pressed button". Hover gets
  //     surface-2 fill + border for affordance.
  //   - Active chip: surface-2 fill, border-2, soft inset shadow — looks
  //     pressed-in, not painted-on. Exception: `[data-key="inbox"]`
  //     active chip gets the accent-soft treatment because Inbox is the
  //     workflow-critical scope (matches index.html lines 689-693).
  //   - Count tail: SEPARATE pill badge (surface-3 / text-3). When the
  //     chip is active, the badge flips to surface / text. Zero counts
  //     are dimmed but the chip stays clickable.
  //
  // Multi-select semantics: each chip toggles its membership in
  // `selectedValues`. The optional × button at the end clears the
  // entire axis (only rendered when at least one chip is selected).
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
  <span class="axis-label">{label}</span>
  <div class="axis-chips">
    {#each options as opt (opt.value)}
      {@const active = selectedValues.includes(opt.value)}
      <button
        type="button"
        class="chip axis-chip"
        data-active={active ? "1" : "0"}
        data-axis={axisKey}
        data-key={opt.value}
        data-empty={opt.predictedCount === 0 ? "1" : "0"}
        onclick={() => onToggle(opt.value)}
      >
        <span>{opt.label}</span>
        <span class="axis-chip-count">{opt.predictedCount}</span>
      </button>
    {/each}
    {#if hasSelection}
      <button
        type="button"
        class="clear-axis"
        aria-label={m.axis_row_clear_axis_aria({ axis: label })}
        onclick={onClearAxis}
      >×</button>
    {/if}
  </div>
</div>

<style>
  /* Mirrors docs/design/v2/ui-kit/index.html .axis-row lines 628-665.
   * 76px label column + 1fr chip strip. On <720px viewports the label
   * stacks on top so the relationship stays obvious when chips wrap. */
  .axis-row {
    display: grid;
    grid-template-columns: 76px 1fr;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3) 0;
    border-bottom: 1px solid var(--border-hairline);
    min-width: 0;
  }
  /* Last axis-row in the panel — the feed below is the visual separator
   * (prototype index.html line 535). The orchestrator wraps these in
   * `.filters-panel` which already has its own bottom border; suppress
   * the trailing hairline so we don't double up. */
  .axis-row:last-child {
    border-bottom: 0;
  }

  .axis-label {
    font-family: var(--f-sans);
    font-size: 10.5px;
    font-weight: var(--w-sb);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding-top: 2px;
    align-self: center;
  }

  .axis-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
    min-height: var(--hit);
    min-width: 0;
  }

  /* Base chip (mirrors prototype `.chip` lines 483-499). Then the
   * `.axis-chip` override on top (lines 666-708) makes the default
   * transparent. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    height: 32px;
    padding: 0 12px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-2);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .chip:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }
  .chip[data-active="1"] {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border-2);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.04) inset,
      0 1px 2px rgba(0, 0, 0, 0.18);
  }
  /* Inbox is workflow-critical — paint its active chip with the accent
   * so it reads as "you are in triage mode" (index.html lines 689-693). */
  .chip[data-active="1"][data-key="inbox"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 50%, transparent);
    color: var(--accent-strong);
    box-shadow: none;
  }

  /* Count badge (index.html lines 696-708). Standalone pill; flips
   * tone when the parent chip is active. */
  .axis-chip-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    background: var(--surface-3);
    color: var(--text-3);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
  .chip[data-active="1"] .axis-chip-count {
    background: var(--surface);
    color: var(--text);
  }
  .chip[data-active="1"][data-key="inbox"] .axis-chip-count {
    background: var(--accent);
    color: var(--accent-text);
  }
  .chip[data-empty="1"] .axis-chip-count {
    opacity: 0.5;
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

  /* Narrow viewports — label stacks on top of chips (index.html lines
   * 648-655). */
  @media (max-width: 720px) {
    .axis-row {
      grid-template-columns: 1fr;
      gap: 6px;
      padding: var(--s-3) 0;
    }
    .axis-label {
      padding-top: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chip,
    .clear-axis {
      transition: none;
    }
  }
</style>

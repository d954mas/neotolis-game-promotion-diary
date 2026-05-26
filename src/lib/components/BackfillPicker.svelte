<script lang="ts">
  // BackfillPicker — initial-backfill window selector for new YouTube channel
  // sources. Pill-button row matches DateRangeControl on /feed (UX feedback,
  // 2026-05-06): same visual language across the app for "pick a time
  // window".
  //
  // Helper text per preset spells out BOTH limits — date cutoff AND the
  // 1000-event cap baked into the worker (MAX_PAGES × PAGE_SIZE in
  // youtube-channel-context-backfill.ts). Both apply at once; whichever
  // hits first stops the import. For typical indie channels the cap is
  // not load-bearing — the date cutoff exits first. The cap matters only
  // for huge back-catalogs where 'All' is selected.
  //
  // Conditional rendering — the parent (/sources/new) only renders this
  // component when kind === 'youtube_channel' AND auto_import === true;
  // toggling either off collapses the picker AND resets value to '30d'.
  // We do not enforce that contract here — the parent owns the gate so
  // the picker stays composable.

  import { m } from "$lib/paraglide/messages.js";

  type Preset = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

  let {
    value = $bindable<Preset>("30d"),
    customDate = $bindable<string | null>(null),
    maxDate,
  }: {
    value?: Preset;
    /** Optional custom date (YYYY-MM-DD). When non-null, overrides the
     *  preset — consumer should derive the absolute date from this
     *  string instead of the preset. Empty / null means "use preset". */
    customDate?: string | null;
    /** YYYY-MM-DD upper bound for the custom-date input. Edit flow
     *  passes the source's current backfillTargetSince so the user
     *  can only move the window earlier (server enforces too). */
    maxDate?: string;
  } = $props();

  const presets: { id: Preset; label: () => string }[] = [
    { id: "1d", label: m.backfill_picker_preset_1d_label },
    { id: "7d", label: m.backfill_picker_preset_7d_label },
    { id: "30d", label: m.backfill_picker_preset_30d_label },
    { id: "90d", label: m.backfill_picker_preset_90d_label },
    { id: "1y", label: m.backfill_picker_preset_1y_label },
    { id: "everything", label: m.backfill_picker_preset_everything_label },
  ];

  const todayISO = new Date().toISOString().slice(0, 10);
  let customExpanded = $state(customDate !== null && customDate !== "");
  function pickPreset(id: Preset): void {
    value = id;
    customDate = null;
  }

  const helperText = $derived.by(() => {
    switch (value) {
      case "1d":
        return m.backfill_picker_helper_1d();
      case "7d":
        return m.backfill_picker_helper_7d();
      case "30d":
        return m.backfill_picker_helper_30d();
      case "90d":
        return m.backfill_picker_helper_90d();
      case "1y":
        return m.backfill_picker_helper_1y();
      case "everything":
        return m.backfill_picker_helper_everything();
    }
  });
</script>

<div class="backfill-picker">
  <span class="legend">{m.backfill_picker_section_title()}</span>
  <div class="presets" role="group" aria-label="Initial backfill window">
    {#each presets as preset (preset.id)}
      <button
        type="button"
        class="preset"
        aria-pressed={value === preset.id && !customDate}
        onclick={() => pickPreset(preset.id)}
      >
        {preset.label()}
      </button>
    {/each}
  </div>
  <details class="custom-date" bind:open={customExpanded}>
    <summary>Or pick a custom date…</summary>
    <div class="custom-date-row">
      <input
        type="date"
        class="custom-date-input"
        bind:value={customDate}
        min="2005-01-01"
        max={maxDate ?? todayISO}
      />
      <!-- No Clear button — clicking any preset chip above already
           clears customDate via pickPreset(). Two paths for the same
           action read as redundant UX. -->
    </div>
  </details>
  <p class="blurb">{m.backfill_picker_section_blurb()}</p>
  <small class="helper">
    {#if customDate}
      Pulling events submitted on or after <b>{customDate}</b>.
    {:else}
      {helperText}
    {/if}
  </small>
</div>

<style>
  /* v2 backfill picker — preset-pill cluster matching DateRangeControl
   * recipe. 5-preset behavioral contract (1d / 7d / 30d / 90d / 1y /
   * everything) preserved from Phase 03.0 plan 12 — script unchanged. */
  .backfill-picker {
    padding: var(--s-4) 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .legend {
    font-family: var(--f-sans);
    font-weight: var(--w-sb);
    font-size: var(--t-14);
    color: var(--text);
  }
  /* Preset cluster sits in a subtle --surface-2 well so the 5-preset
   * group reads as a single control. Matches DateRangeControl's
   * affordance language. */
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    padding: var(--s-1);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .preset {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--text-2);
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .preset:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .preset[aria-pressed="true"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  /* :focus-visible inherits the global var(--focus-ring) box-shadow from app.css */
  .blurb {
    color: var(--text-3);
    font-size: var(--t-13);
    margin: 0;
    line-height: var(--lh-body);
  }
  .helper {
    color: var(--text-3);
    font-size: var(--t-12);
    display: block;
    line-height: var(--lh-body);
  }
  .helper b {
    color: var(--text);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
  /* Custom-date disclosure — collapsed by default; reveals a date
   * input + Clear button when expanded. */
  .custom-date {
    margin-top: 2px;
  }
  .custom-date > summary {
    list-style: none;
    cursor: pointer;
    color: var(--text-3);
    font-size: var(--t-12);
    padding: 4px 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .custom-date > summary::-webkit-details-marker {
    display: none;
  }
  .custom-date > summary::before {
    content: "›";
    color: var(--accent);
    font-size: 14px;
    line-height: 1;
    transition: transform var(--m-fast) var(--m-ease);
  }
  .custom-date[open] > summary::before {
    transform: rotate(90deg);
  }
  .custom-date > summary:hover {
    color: var(--text);
  }
  .custom-date-row {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 0 2px;
  }
  .custom-date-input {
    min-height: 36px;
    padding: 0 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    font-size: var(--t-13);
    font-family: var(--f-mono);
    outline: none;
    color-scheme: dark;
  }
  .custom-date-input:focus {
    border-color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .preset {
      transition: none;
    }
  }
</style>

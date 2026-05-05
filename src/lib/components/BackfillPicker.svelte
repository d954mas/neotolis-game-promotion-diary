<script lang="ts">
  // BackfillPicker — radio group for the YouTube channel registration
  // initial-backfill window (UI-SPEC §"Component inventory" + D-09).
  //
  // 5 presets: 1 day / 7 days / 30 days (default) / 90 days / Everything.
  // Each row carries a quota-cost hint:
  //   1d / 7d / 30d / 90d → ≈ 1 quota unit
  //   Everything          → up to ≈ 20 quota units (one-time)
  //
  // Helper paragraph below the radio group switches based on the currently-
  // selected preset:
  //   - 1d  → "Picks up only new content from this moment — past videos
  //           won't be imported."
  //   - 30d / 7d / 90d / everything → "30 days fits most active devlogs
  //           without spending much quota."
  //
  // The picker is a fieldset+legend so the radio group reads as one
  // accessible name ("Initial backfill"), not five separate widgets.
  // Each <label> wraps its <input type="radio"> so the entire 44px row
  // is the click target on mobile (UI-SPEC §"Spacing Scale" exception).
  //
  // Conditional rendering — the parent (/sources/new) only renders this
  // component when kind === 'youtube_channel' AND auto_import === true;
  // toggling either off collapses the picker AND resets value to '30d'.
  // We do not enforce that contract here — the parent owns the gate so
  // the picker stays composable.

  import { m } from "$lib/paraglide/messages.js";

  type Preset = "1d" | "7d" | "30d" | "90d" | "everything";

  let { value = $bindable<Preset>("30d") }: { value?: Preset } = $props();

  type PresetRow = {
    id: Preset;
    label: () => string;
    cost: () => string;
  };

  const presets: PresetRow[] = [
    {
      id: "1d",
      label: m.backfill_picker_preset_1d_label,
      cost: m.backfill_picker_preset_cost_low,
    },
    {
      id: "7d",
      label: m.backfill_picker_preset_7d_label,
      cost: m.backfill_picker_preset_cost_low,
    },
    {
      id: "30d",
      label: m.backfill_picker_preset_30d_label,
      cost: m.backfill_picker_preset_cost_low,
    },
    {
      id: "90d",
      label: m.backfill_picker_preset_90d_label,
      cost: m.backfill_picker_preset_cost_low,
    },
    {
      id: "everything",
      label: m.backfill_picker_preset_everything_label,
      cost: m.backfill_picker_preset_cost_everything,
    },
  ];

  const helperText = $derived(
    value === "1d" ? m.backfill_picker_helper_1d() : m.backfill_picker_helper_default(),
  );
</script>

<fieldset class="backfill-picker">
  <legend class="legend">{m.backfill_picker_section_title()}</legend>
  <p class="blurb">{m.backfill_picker_section_blurb()}</p>
  <div class="presets" role="presentation">
    {#each presets as preset (preset.id)}
      <label class="preset-row" class:selected={value === preset.id}>
        <input type="radio" name="backfill_window" value={preset.id} bind:group={value} />
        <span class="preset-label">{preset.label()}</span>
        <span class="preset-cost">{preset.cost()}</span>
      </label>
    {/each}
  </div>
  <small class="helper">{helperText}</small>
</fieldset>

<style>
  .backfill-picker {
    border: none;
    padding: var(--space-md) 0;
    margin: 0;
  }
  .legend {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-body);
    padding: 0;
  }
  .blurb {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin: var(--space-xs) 0 var(--space-md);
  }
  .presets {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  /* UI-SPEC §"Spacing Scale" exception — 44px tap row on mobile. The
     <label> wraps the <input> so the entire row receives clicks. The
     three-column grid keeps the cost hint right-aligned across rows. */
  .preset-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-sm);
    min-height: 44px;
    padding: 0 var(--space-sm);
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
  }
  .preset-row.selected {
    border-color: var(--color-accent);
    /* UI-SPEC §"Color → Accent (10%) — new surfaces": the selected radio
       reads as locked-in, matching the form's Save source CTA visually. */
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }
  .preset-row input[type="radio"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  .preset-label {
    font-size: var(--font-size-body);
    color: var(--color-text);
  }
  .preset-cost {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .helper {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin-top: var(--space-sm);
    display: block;
  }
</style>

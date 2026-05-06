<script lang="ts">
  // BackfillPicker — initial-backfill window selector for new YouTube channel
  // sources. Compact dropdown rather than radio group: 5 presets fit on one
  // line and the form already has enough vertical surface (UX feedback,
  // 2026-05-06).
  //
  // Quota cost hint removed — that's an operator concern surfaced on /admin,
  // not user-facing. The user picks a window; the operator's worker handles
  // quota safely (current handler hard-caps at 50 most-recent videos
  // regardless of window — bounded by construction).
  //
  // Conditional rendering — the parent (/sources/new) only renders this
  // component when kind === 'youtube_channel' AND auto_import === true;
  // toggling either off collapses the picker AND resets value to '30d'.
  // We do not enforce that contract here — the parent owns the gate so
  // the picker stays composable.

  import { m } from "$lib/paraglide/messages.js";

  type Preset = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

  let { value = $bindable<Preset>("30d") }: { value?: Preset } = $props();

  const presets: { id: Preset; label: () => string }[] = [
    { id: "1d", label: m.backfill_picker_preset_1d_label },
    { id: "7d", label: m.backfill_picker_preset_7d_label },
    { id: "30d", label: m.backfill_picker_preset_30d_label },
    { id: "90d", label: m.backfill_picker_preset_90d_label },
    { id: "1y", label: m.backfill_picker_preset_1y_label },
    { id: "everything", label: m.backfill_picker_preset_everything_label },
  ];

  const helperText = $derived(
    value === "1d" ? m.backfill_picker_helper_1d() : m.backfill_picker_helper_default(),
  );
</script>

<div class="backfill-picker">
  <label class="row">
    <span class="legend">{m.backfill_picker_section_title()}</span>
    <select name="backfill_window" bind:value class="select">
      {#each presets as preset (preset.id)}
        <option value={preset.id}>{preset.label()}</option>
      {/each}
    </select>
  </label>
  <p class="blurb">{m.backfill_picker_section_blurb()}</p>
  <small class="helper">{helperText}</small>
</div>

<style>
  .backfill-picker {
    padding: var(--space-md) 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .legend {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-body);
  }
  .select {
    font-size: var(--font-size-body);
    padding: var(--space-xs) var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
    min-height: 36px;
    min-width: 140px;
    cursor: pointer;
  }
  .select:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .blurb {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    margin: 0;
  }
  .helper {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    display: block;
  }
</style>

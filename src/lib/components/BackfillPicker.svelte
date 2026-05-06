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

  let { value = $bindable<Preset>("30d") }: { value?: Preset } = $props();

  const presets: { id: Preset; label: () => string }[] = [
    { id: "1d", label: m.backfill_picker_preset_1d_label },
    { id: "7d", label: m.backfill_picker_preset_7d_label },
    { id: "30d", label: m.backfill_picker_preset_30d_label },
    { id: "90d", label: m.backfill_picker_preset_90d_label },
    { id: "1y", label: m.backfill_picker_preset_1y_label },
    { id: "everything", label: m.backfill_picker_preset_everything_label },
  ];

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
        aria-pressed={value === preset.id}
        onclick={() => (value = preset.id)}
      >
        {preset.label()}
      </button>
    {/each}
  </div>
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
  .legend {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-body);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
  }
  .preset {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .preset[aria-pressed="true"] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .preset:focus-visible {
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

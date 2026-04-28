<script lang="ts">
  // DateRangeControl — primary date-range picker for /feed (Plan 02.1-15
  // closing VERIFICATION.md Gap 10).
  //
  // Sits above <FilterChips> in /feed; owns from/to entirely. Plan 02.1-15
  // also strips from/to fields out of <FiltersSheet> — date is no longer a
  // sheet-only control.
  //
  // Quick presets: Today | Last 7 days | Last 30 days | All time | Custom…
  // The currently-active preset gets aria-pressed=true + accent border.
  // "All time" emits { all: true } which the page-server reads as
  // ?all=1 (opt-out from the 30-day default — Gap 9).

  import { m } from "$lib/paraglide/messages.js";

  type ActiveFilters = {
    from?: string;
    to?: string;
    defaultDateRange: boolean;
    all: boolean;
  };

  let {
    activeFilters,
    onApply,
  }: {
    activeFilters: ActiveFilters;
    onApply: (next: { from?: string; to?: string; all?: boolean }) => void;
  } = $props();

  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }
  function daysAgoIso(n: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // Match the supplied range against the four canonical presets. Custom
  // returns when the range doesn't line up — neither boundary matches a
  // preset day count. The "default" 30-day window matches "30d" because the
  // page-server emits the same from / to values; the defaultDateRange flag
  // only affects the chip-strip rendering (whether we show the
  // "(default)" suffix).
  const activePreset = $derived.by(() => {
    if (activeFilters.all) return "all";
    if (activeFilters.defaultDateRange) return "30d";
    if (!activeFilters.from && !activeFilters.to) return "all";
    const today = todayIso();
    if (activeFilters.from === today && activeFilters.to === today) return "today";
    if (activeFilters.from === daysAgoIso(7) && activeFilters.to === today) return "7d";
    if (activeFilters.from === daysAgoIso(30) && activeFilters.to === today) return "30d";
    return "custom";
  });

  let customOpen = $state(activePreset === "custom");
  let customFrom = $state(activeFilters.from ?? "");
  let customTo = $state(activeFilters.to ?? "");

  function applyPreset(p: "today" | "7d" | "30d" | "all"): void {
    if (p === "today") onApply({ from: todayIso(), to: todayIso() });
    else if (p === "7d") onApply({ from: daysAgoIso(7), to: todayIso() });
    else if (p === "30d") onApply({ from: daysAgoIso(30), to: todayIso() });
    else onApply({ all: true });
  }
  function applyCustom(): void {
    onApply({ from: customFrom || undefined, to: customTo || undefined });
  }
</script>

<div class="date-range" role="group" aria-label="Date range">
  <button
    type="button"
    class="preset"
    aria-pressed={activePreset === "today"}
    onclick={() => applyPreset("today")}
  >
    {m.feed_date_range_today()}
  </button>
  <button
    type="button"
    class="preset"
    aria-pressed={activePreset === "7d"}
    onclick={() => applyPreset("7d")}
  >
    {m.feed_date_range_7d()}
  </button>
  <button
    type="button"
    class="preset"
    aria-pressed={activePreset === "30d"}
    onclick={() => applyPreset("30d")}
  >
    {m.feed_date_range_30d()}
  </button>
  <button
    type="button"
    class="preset"
    aria-pressed={activePreset === "all"}
    onclick={() => applyPreset("all")}
  >
    {m.feed_date_range_all()}
  </button>
  <button
    type="button"
    class="preset"
    aria-pressed={activePreset === "custom"}
    onclick={() => (customOpen = !customOpen)}
  >
    {m.feed_date_range_custom()}
  </button>
  {#if customOpen}
    <div class="custom">
      <label>
        {m.feed_date_range_label_from()}
        <input type="date" bind:value={customFrom} max={customTo || undefined} />
      </label>
      <label>
        {m.feed_date_range_label_to()}
        <input type="date" bind:value={customTo} min={customFrom || undefined} />
      </label>
      <button type="button" class="preset" onclick={applyCustom}>
        {m.feed_filters_apply()}
      </button>
    </div>
  {/if}
</div>

<style>
  .date-range {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
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
  .custom {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: end;
    flex-basis: 100%;
  }
  .custom label {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .custom input {
    min-height: 44px;
    padding: 0 var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
  }
</style>

<script lang="ts">
  // DateRangeControl — primary date-range picker for /feed (Plan 02.1-15
  // Gap 10; rewritten in Plan 02.1-19 round-2 UAT closure).
  //
  // Plan 02.1-19 changes:
  //   - From/To inputs ARE always visible. The Plan 02.1-15 "Custom" raise-
  //     toggle pattern is GONE (UAT round-2 rejected hidden inputs).
  //   - 4 quick presets: Today | Week | Month | Year (each fills both inputs).
  //   - × (clear) emits { all: true } → URL becomes ?all=1 (semantically
  //     equivalent to the old "All time" preset; opt-out from the 30-day
  //     default — Gap 9).
  //   - The visible from/to inputs ARE the date indicator. FilterChips no
  //     longer emits a date chip (round-2 UAT gap "no chip duplication").
  //
  // Sits above <FilterChips> on /feed; owns from/to entirely.

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

  // Local state for the always-visible inputs. Re-syncs when activeFilters
  // changes (preset click / ×-clear → server-side state is the source of
  // truth, so the inputs reflect the next render).
  let fromVal = $state(activeFilters.from ?? "");
  let toVal = $state(activeFilters.to ?? "");
  $effect(() => {
    fromVal = activeFilters.from ?? "";
    toVal = activeFilters.to ?? "";
  });

  // Match the supplied range against the four presets. "Custom" returns null
  // (no preset highlighted). The "default" 30-day window matches "month"
  // because the page-server emits the same from / to values for both.
  const activePreset = $derived.by((): "today" | "week" | "month" | "year" | null => {
    if (activeFilters.all) return null;
    const today = todayIso();
    const from = activeFilters.from;
    const to = activeFilters.to;
    if (!from && !to) return null;
    if (from === today && to === today) return "today";
    if (from === daysAgoIso(7) && to === today) return "week";
    if (from === daysAgoIso(30) && to === today) return "month";
    if (from === daysAgoIso(365) && to === today) return "year";
    return null;
  });

  function applyPreset(p: "today" | "week" | "month" | "year"): void {
    const today = todayIso();
    if (p === "today") onApply({ from: today, to: today });
    else if (p === "week") onApply({ from: daysAgoIso(7), to: today });
    else if (p === "month") onApply({ from: daysAgoIso(30), to: today });
    else onApply({ from: daysAgoIso(365), to: today });
  }
  function applyInputs(): void {
    onApply({ from: fromVal || undefined, to: toVal || undefined });
  }
  function clearRange(): void {
    fromVal = "";
    toVal = "";
    onApply({ all: true });
  }
</script>

<div class="date-range" role="group" aria-label="Date range">
  <div class="inputs">
    <label class="input-wrap">
      <span class="input-label">{m.feed_date_range_label_from()}</span>
      <input
        type="date"
        bind:value={fromVal}
        max={toVal || undefined}
        onchange={applyInputs}
      />
    </label>
    <label class="input-wrap">
      <span class="input-label">{m.feed_date_range_label_to()}</span>
      <input
        type="date"
        bind:value={toVal}
        min={fromVal || undefined}
        onchange={applyInputs}
      />
    </label>
    <button
      type="button"
      class="clear"
      aria-label={m.feed_date_range_clear()}
      onclick={clearRange}
    >×</button>
  </div>
  <div class="presets">
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
      aria-pressed={activePreset === "week"}
      onclick={() => applyPreset("week")}
    >
      {m.feed_date_range_week()}
    </button>
    <button
      type="button"
      class="preset"
      aria-pressed={activePreset === "month"}
      onclick={() => applyPreset("month")}
    >
      {m.feed_date_range_month()}
    </button>
    <button
      type="button"
      class="preset"
      aria-pressed={activePreset === "year"}
      onclick={() => applyPreset("year")}
    >
      {m.feed_date_range_year()}
    </button>
  </div>
</div>

<style>
  .date-range {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .inputs {
    display: flex;
    gap: var(--space-sm);
    align-items: end;
    flex-wrap: wrap;
  }
  .input-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input-wrap input {
    min-height: 44px;
    padding: 0 var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text);
  }
  .clear {
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .clear:hover {
    color: var(--color-text);
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
</style>

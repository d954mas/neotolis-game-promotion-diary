<script lang="ts">
  // DateRangeControl — primary date-range picker for /feed.
  //
  //   - From/To inputs are always visible.
  //   - 4 quick presets: Today | Week | Month | Year (each fills both inputs).
  //   - × (clear) emits { all: true } → URL becomes ?all=1 (opt-out from
  //     the 30-day default).
  //   - The visible from/to inputs ARE the date indicator. FilterChips does
  //     not emit a date chip (no chip duplication).
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
  const activePreset = $derived.by((): "today" | "week" | "month" | "all" | null => {
    if (activeFilters.all) return "all";
    const today = todayIso();
    const from = activeFilters.from;
    const to = activeFilters.to;
    if (!from && !to) return null;
    if (from === today && to === today) return "today";
    if (from === daysAgoIso(7) && to === today) return "week";
    if (from === daysAgoIso(30) && to === today) return "month";
    return null;
  });

  function applyPreset(p: "today" | "week" | "month" | "all"): void {
    const today = todayIso();
    if (p === "today") onApply({ from: today, to: today });
    else if (p === "week") onApply({ from: daysAgoIso(7), to: today });
    else if (p === "month") onApply({ from: daysAgoIso(30), to: today });
    else onApply({ all: true });
  }
  function applyInputs(): void {
    onApply({ from: fromVal || undefined, to: toVal || undefined });
  }
</script>

<div class="date-range" role="group" aria-label="Date range">
  <div class="inputs">
    <label class="input-wrap">
      <span class="input-label">{m.feed_date_range_label_from()}</span>
      <input type="date" bind:value={fromVal} max={toVal || undefined} onchange={applyInputs} />
    </label>
    <label class="input-wrap">
      <span class="input-label">{m.feed_date_range_label_to()}</span>
      <input type="date" bind:value={toVal} min={fromVal || undefined} onchange={applyInputs} />
    </label>
  </div>
  <div class="presets">
    <button
      type="button"
      class="preset"
      aria-pressed={activePreset === "all"}
      onclick={() => applyPreset("all")}
    >
      {m.feed_date_range_all_time()}
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
      aria-pressed={activePreset === "week"}
      onclick={() => applyPreset("week")}
    >
      {m.feed_date_range_week()}
    </button>
    <button
      type="button"
      class="preset"
      aria-pressed={activePreset === "today"}
      onclick={() => applyPreset("today")}
    >
      {m.feed_date_range_today()}
    </button>
  </div>
</div>

<style>
  /* v2 date-range control — --surface-2 input boxes + --r-pill preset chips.
   * Native date-picker filter invert on dark theme is the global LB-8 rule
   * in src/app.css (input[type="date"]::-webkit-calendar-picker-indicator);
   * not duplicated here. */
  .date-range {
    display: flex;
    flex-direction: row;
    align-items: end;
    gap: var(--s-4);
    flex-wrap: wrap;
  }
  .inputs {
    display: flex;
    gap: var(--s-2);
    align-items: end;
    flex-wrap: wrap;
  }
  .input-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .input-label {
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .input-wrap input {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input-wrap input:hover {
    border-color: var(--accent-strong);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
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
  @media (prefers-reduced-motion: reduce) {
    .input-wrap input,
    .preset {
      transition: none;
    }
  }
</style>

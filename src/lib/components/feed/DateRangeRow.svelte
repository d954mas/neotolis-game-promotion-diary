<script lang="ts">
  // DateRangeRow — Wave 2a floor-2 chrome for /feed (Plan 03.4-07 Task 2).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 764-826. Renders a row of
  // five preset chips (All time / Year / Month / Week / Today) plus a
  // custom-range chip that opens <DateRangePicker> plus a sort toggle
  // (Newest ↓ / Oldest ↑).
  //
  // State surface: receives `dateRange` (DateRangeFilter discriminated
  // union from $lib/feed/url-state.js — the URL is the single source of
  // truth) and emits state changes via `onDateRangeChange`. Same
  // pattern for `sortDir` (which is also a URL param). The picker is
  // local UI state (open/closed) so it lives inside the component.

  import DateRangePicker from "./DateRangePicker.svelte";
  import { fmtMonthDay, parseEventDate } from "$lib/feed/date-range.js";
  import { m } from "$lib/paraglide/messages.js";
  import type { DateRangeFilter } from "$lib/feed/url-state.js";

  let {
    dateRange,
    onDateRangeChange,
    sortDir,
    onSortDirChange,
    today,
  }: {
    dateRange: DateRangeFilter;
    onDateRangeChange: (next: DateRangeFilter) => void;
    sortDir: "asc" | "desc";
    onSortDirChange: (next: "asc" | "desc") => void;
    today: Date;
  } = $props();

  let pickerOpen = $state<boolean>(false);

  function chipLabel(): string {
    if (dateRange.preset === "custom") {
      const from = parseEventDate(dateRange.from);
      const to = parseEventDate(dateRange.to);
      if (!from || !to) return m.feed_date_range_chip_label_all_time();
      return `${fmtMonthDay(from)} – ${fmtMonthDay(to)}`;
    }
    if (dateRange.preset === "today") return m.feed_date_range_preset_today();
    if (dateRange.preset === "week") return m.feed_date_range_preset_week();
    if (dateRange.preset === "month") return m.feed_date_range_preset_month();
    if (dateRange.preset === "year") return m.feed_date_range_preset_year();
    return m.feed_date_range_chip_label_all_time();
  }

  // Current value passed into the picker — null for non-custom, the
  // parsed Date pair for custom ranges.
  let pickerValue = $derived.by((): { from: Date | null; to: Date | null } | null => {
    if (dateRange.preset !== "custom") return null;
    const from = parseEventDate(dateRange.from);
    const to = parseEventDate(dateRange.to);
    if (!from || !to) return null;
    return { from, to };
  });

  function toIsoLocal(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
</script>

<div class="date-range-row">
  <button
    type="button"
    class="date-chip"
    data-custom={dateRange.preset === "custom" ? "1" : "0"}
    onclick={() => (pickerOpen = true)}
    title="Pick a custom range"
  >
    <span aria-hidden="true">📅</span>
    <span>{chipLabel()}</span>
  </button>

  <div class="preset-chips">
    <button
      type="button"
      class="chip"
      data-active={dateRange.preset === "all" ? "1" : "0"}
      onclick={() => onDateRangeChange({ preset: "all" })}
    >
      {m.feed_date_range_chip_label_all_time()}
    </button>
    <button
      type="button"
      class="chip"
      data-active={dateRange.preset === "year" ? "1" : "0"}
      onclick={() => onDateRangeChange({ preset: "year" })}
    >
      {m.feed_date_range_preset_year()}
    </button>
    <button
      type="button"
      class="chip"
      data-active={dateRange.preset === "month" ? "1" : "0"}
      onclick={() => onDateRangeChange({ preset: "month" })}
    >
      {m.feed_date_range_preset_month()}
    </button>
    <button
      type="button"
      class="chip"
      data-active={dateRange.preset === "week" ? "1" : "0"}
      onclick={() => onDateRangeChange({ preset: "week" })}
    >
      {m.feed_date_range_preset_week()}
    </button>
    <button
      type="button"
      class="chip"
      data-active={dateRange.preset === "today" ? "1" : "0"}
      onclick={() => onDateRangeChange({ preset: "today" })}
    >
      {m.feed_date_range_preset_today()}
    </button>
  </div>

  <button
    type="button"
    class="sort-toggle"
    onclick={() => onSortDirChange(sortDir === "desc" ? "asc" : "desc")}
    title="Toggle sort order"
  >
    <span aria-hidden="true">{sortDir === "desc" ? "↓" : "↑"}</span>
    <span>
      {sortDir === "desc"
        ? m.feed_date_range_sort_newest_first()
        : m.feed_date_range_sort_oldest_first()}
    </span>
  </button>
</div>

<DateRangePicker
  value={pickerValue}
  open={pickerOpen}
  {today}
  onApply={(range) => {
    onDateRangeChange({
      preset: "custom",
      from: toIsoLocal(range.from),
      to: toIsoLocal(range.to),
    });
    pickerOpen = false;
  }}
  onClear={() => {
    onDateRangeChange({ preset: "all" });
    pickerOpen = false;
  }}
  onClose={() => (pickerOpen = false)}
/>

<style>
  .date-range-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
  }

  .date-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    height: 32px;
    min-height: 32px;
    padding: 0 var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .date-chip:hover {
    background: var(--surface-2);
    border-color: var(--accent);
  }
  .date-chip[data-custom="1"] {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
    color: var(--accent);
    font-weight: var(--w-sb);
  }

  .preset-chips {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .chip:hover {
    border-color: var(--accent);
  }
  .chip[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
    font-weight: var(--w-sb);
  }

  .sort-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    height: 32px;
    padding: 0 var(--s-3);
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    margin-left: auto;
    transition:
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .sort-toggle:hover {
    color: var(--text);
    border-color: var(--accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .date-chip,
    .chip,
    .sort-toggle {
      transition: none;
    }
  }
</style>

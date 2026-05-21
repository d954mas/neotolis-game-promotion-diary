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
  import { fmtMonthDay, parseEventDate, dateRangeWindow } from "$lib/feed/date-range.js";
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
  let chipEl: HTMLButtonElement | undefined = $state();
  let anchorTop = $state<number>(0);
  let anchorLeft = $state<number>(0);

  function openPicker(): void {
    if (chipEl) {
      const rect = chipEl.getBoundingClientRect();
      anchorTop = rect.bottom + 4;
      anchorLeft = rect.left;
    }
    pickerOpen = true;
  }

  // Chip label mirrors prototype docs/design/v2/ui-kit/app.jsx lines 774-778:
  // shows the RESOLVED date range for preset values (e.g., "Apr 13 — May 14"
  // for `month`), not the preset name itself. Preset chips below carry the
  // semantic name.
  function chipLabel(): string {
    if (dateRange.preset === "custom") {
      const from = parseEventDate(dateRange.from);
      const to = parseEventDate(dateRange.to);
      if (!from || !to) return m.feed_date_range_chip_label_all_time();
      return `${fmtMonthDay(from)} – ${fmtMonthDay(to)}`;
    }
    if (dateRange.preset === "all") return m.feed_date_range_chip_label_all_time();
    if (dateRange.preset === "today") return fmtMonthDay(today);
    const win = dateRangeWindow(dateRange.preset, today);
    if (!win) return m.feed_date_range_chip_label_all_time();
    return `${fmtMonthDay(win.from)} – ${fmtMonthDay(win.to)}`;
  }

  // Current value passed into the picker. For custom ranges, parse the
  // ISO strings. For preset ranges (month/week/year/today), resolve the
  // preset window so the picker opens with the current view's range
  // visually highlighted — matches prototype behavior where the user
  // sees what's currently selected before adjusting. "All time" / null
  // leaves the picker empty.
  let pickerValue = $derived.by((): { from: Date | null; to: Date | null } | null => {
    if (dateRange.preset === "custom") {
      const from = parseEventDate(dateRange.from);
      const to = parseEventDate(dateRange.to);
      if (!from || !to) return null;
      return { from, to };
    }
    if (dateRange.preset === "all") return null;
    if (dateRange.preset === "today") return { from: today, to: today };
    const win = dateRangeWindow(dateRange.preset, today);
    if (!win) return null;
    return { from: win.from, to: win.to };
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
    bind:this={chipEl}
    type="button"
    class="date-chip"
    data-custom={dateRange.preset === "custom" ? "1" : "0"}
    onclick={openPicker}
    title="Pick a custom range"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </svg>
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
  anchorTop={anchorTop}
  anchorLeft={anchorLeft}
  {today}
  onApply={(range) => {
    // Don't auto-close on range completion — prototype keeps the picker
    // open so the user can keep adjusting until they explicitly dismiss
    // via Close button / click-outside / Esc. The range commits to URL
    // state immediately so the feed updates while the picker stays open.
    onDateRangeChange({
      preset: "custom",
      from: toIsoLocal(range.from),
      to: toIsoLocal(range.to),
    });
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

  /* Date-chip uses --r-sm (rectangular) per prototype `.btn.date-chip`
   * inheriting from base `.btn` (docs/design/v2/ui-kit/index.html
   * line 439: border-radius: var(--r-sm)). NOT pill — pill is for
   * the smaller preset chips only. */
  .date-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    height: 32px;
    min-height: 32px;
    padding: 0 var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .date-chip:hover {
    background: var(--surface-2);
    border-color: var(--accent);
  }
  .date-chip[data-custom="1"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 45%, var(--border));
    color: var(--accent-strong);
    font-weight: var(--w-sb);
  }
  .date-chip[data-custom="1"] svg {
    color: var(--accent-strong);
  }

  .preset-chips {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  /* Base chip — mirrors docs/design/v2/ui-kit/index.html lines 483-499.
   * Pill shape, surface bg, hairline border, text-2 color, 28px tall.
   * Hover deepens to surface-2 + border-2. Active gets the accent-soft
   * tint + accent-strong text (matches the prototype's preset chips
   * sitting alongside the date-chip). */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    height: 28px;
    padding: 0 var(--s-3);
    background: var(--surface);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
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
    border-color: var(--border-2);
  }
  .chip[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent-strong);
    border-color: color-mix(in oklab, var(--accent) 50%, transparent);
  }

  /* Sort toggle sits INLINE with preset chips per prototype
   * docs/design/v2/ui-kit/app.jsx lines 806-814 (`.btn ghost` style,
   * not pushed right). */
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

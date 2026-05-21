<script lang="ts">
  // FindRow — Wave 2a in-result search axis (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 828-864 + index.html
  // `.search-local` / `.find-result` CSS rules (lines 537-562).
  //
  // Search runs AFTER all other filters narrow the visible set — the
  // result count label expresses "how many events match my query INSIDE
  // the current filter scope". Empty query hides the count entirely.
  //
  // Visual contract vs. the prototype:
  //   - `.search-local`: 32px-tall pill (var(--r-sm), not full pill) with
  //     a hairline border, inline search icon at the left, narrow
  //     min-width (220px) — sits inline like a single field, not full
  //     row width.
  //   - When focused: border flips to accent, background to surface-2.
  //   - Clear button (×): only appears when value is non-empty;
  //     circular subtle hover target. Native search input's built-in ×
  //     is suppressed via ::-webkit-search-cancel-button so the styled
  //     button is the only one rendered.
  //   - `.find-result`: small text-3 12px monospace digits sitting to
  //     the right of the input.
  //
  // Distinct from PageHead's utility-row search (`?q=` axis). The
  // orchestrator mounts this inside the expanded Filters panel only.

  import { m } from "$lib/paraglide/messages.js";

  let {
    query,
    onQueryChange,
    resultCount,
    hasOtherFilters = false,
  }: {
    query: string;
    onQueryChange: (q: string) => void;
    resultCount: number;
    hasOtherFilters?: boolean;
  } = $props();

  let label = $derived(
    query.trim() === ""
      ? ""
      : resultCount === 1
        ? m.find_row_result_count_singular()
        : m.find_row_result_count({ count: String(resultCount) }),
  );
  let suffix = $derived(
    query.trim() !== "" && hasOtherFilters
      ? " " + m.find_row_result_in_filters()
      : "",
  );
</script>

<div class="axis-row find-row" data-no-label="1">
  <div class="search-local">
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
    <input
      type="search"
      placeholder={m.find_row_placeholder()}
      value={query}
      oninput={(e) => onQueryChange(e.currentTarget.value)}
    />
    {#if query.trim() !== ""}
      <button
        type="button"
        class="clear-search"
        aria-label="Clear search"
        onclick={() => onQueryChange("")}
      >×</button>
    {/if}
  </div>
  {#if query.trim() !== ""}
    <span class="find-result">{label}{suffix}</span>
  {/if}
</div>

<style>
  /* `data-no-label="1"` axis-row pattern (index.html lines 528-531) —
   * label column collapses, content spans full width. */
  .axis-row.find-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3) 0;
    border-bottom: 1px solid var(--border-hairline);
    min-width: 0;
  }
  .axis-row.find-row:last-child {
    border-bottom: 0;
  }

  /* index.html .search-local lines 543-562 — narrow inline pill, NOT
   * full-row. min-width 220px keeps it from looking like a page-wide
   * search bar. */
  .search-local {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    min-width: 220px;
    transition:
      border-color var(--m-fast) var(--m-ease),
      background var(--m-fast) var(--m-ease);
  }
  .search-local:focus-within {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .search-local svg {
    width: 14px;
    height: 14px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .search-local input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    color: var(--text);
    font: inherit;
    font-size: var(--t-13);
    outline: none;
  }
  .search-local input::placeholder {
    color: var(--text-3);
  }
  /* Suppress the WebKit native × so our styled clear-search is the
   * single source of truth. */
  .search-local input::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
  }

  .clear-search {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: transparent;
    border: 0;
    color: var(--text-3);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .clear-search:hover {
    background: var(--surface-3);
    color: var(--text);
  }

  /* index.html .find-result lines 537-542 — small tabular-num count
   * sitting next to the input. */
  .find-result {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    margin-left: var(--s-2);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .search-local,
    .clear-search {
      transition: none;
    }
  }
</style>

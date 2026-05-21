<script lang="ts">
  // FindRow — Wave 2a in-result search axis (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 828-864. Search runs
  // AFTER all other filters narrow the visible set — the result count
  // label expresses "how many events match my query INSIDE the current
  // filter scope". Empty query hides the count entirely.
  //
  // Distinct from PageHead's utility-row search: PageHead's search is
  // the URL-bound `?q=` axis (passed through to the SSR loader);
  // FindRow's search is the orchestrator's local in-page narrowing
  // (the prototype lines 838-861 use the same input element for both —
  // we expose a separate component so the orchestrator can mount it
  // inside the expanded Filters panel without colliding with PageHead's
  // utility row when the panel is collapsed).
  //
  // No clear-search button — clearing happens via the native search
  // input's built-in ×-cancel button (type="search").

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

<div class="find-row">
  <input
    type="search"
    class="find-input"
    placeholder={m.find_row_placeholder()}
    value={query}
    oninput={(e) => onQueryChange(e.currentTarget.value)}
  />
  {#if query.trim() !== ""}
    <span class="result-count">{label}{suffix}</span>
  {/if}
</div>

<style>
  .find-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    min-width: 0;
  }

  .find-input {
    flex: 1;
    min-width: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    min-height: 32px;
    transition:
      border-color var(--m-fast) var(--m-ease);
  }
  .find-input::placeholder {
    color: var(--text-3);
  }
  .find-input:focus {
    outline: none;
    box-shadow: var(--focus-ring);
    border-color: var(--accent);
  }

  .result-count {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-motion: reduce) {
    .find-input {
      transition: none;
    }
  }
</style>

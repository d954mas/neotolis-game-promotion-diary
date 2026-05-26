<script lang="ts">
  // CursorPager — "Older →" / "← Newer" pair. No page numbers
  // (cursor pagination is opaque-by-construction).
  //
  // The page consumes /api/audit's `nextCursor` and `prevCursors` (a stack
  // the consumer maintains client-side); this component only exposes the
  // two click affordances and the disabled state when each direction is
  // exhausted.

  let {
    hasNext,
    hasPrev,
    onNext,
    onPrev,
  }: {
    hasNext: boolean;
    hasPrev: boolean;
    onNext: () => void;
    onPrev: () => void;
  } = $props();
</script>

<nav class="pager" aria-label="Pagination">
  <button type="button" class="btn" onclick={onPrev} disabled={!hasPrev}>← Newer</button>
  <button type="button" class="btn" onclick={onNext} disabled={!hasNext}>Older →</button>
</nav>

<style>
  /* v2 CursorPager — "← Newer" / "Older →" button pair on --text-2 base
   * with --accent-soft hover. */
  .pager {
    display: flex;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-4);
    color: var(--text-2);
    font-size: var(--t-13);
  }
  .btn {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .btn:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
</style>

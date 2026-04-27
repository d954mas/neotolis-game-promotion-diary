<script lang="ts">
  // CursorPager — "Older →" / "← Newer" pair (D-31). No page numbers
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
  .pager {
    display: flex;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-md);
  }
  .btn {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>

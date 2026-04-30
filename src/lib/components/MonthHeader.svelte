<script lang="ts">
  // MonthHeader — sticky month-group heading used on /games/[id] curated
  // events panel and on /feed (Plan 02.1-07's consumer).
  //
  // UI-SPEC: visually quiet — uses --color-text-muted and label typography
  // (14px) so the chronological pool below it owns the page's attention.
  // Renders <h2> for screen readers (the page <h1> is the game title /
  // "Feed"; month groups within are <h2>).

  let {
    month,
    count,
  }: {
    month: string;
    count: number;
  } = $props();
</script>

<h2 class="month-header">
  <span class="label">{month}</span>
  <span class="count">— {count} event{count === 1 ? "" : "s"}</span>
</h2>

<style>
  .month-header {
    margin: var(--space-lg) 0 var(--space-sm) 0;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
    position: sticky;
    top: 0;
    background: var(--color-bg);
    padding: var(--space-xs) 0;
    border-bottom: 1px solid var(--color-border);
    line-height: var(--line-height-body);
  }
  .label {
    color: var(--color-text-muted);
  }
  .count {
    color: var(--color-text-muted);
    font-weight: var(--font-weight-regular, 400);
    margin-left: var(--space-xs);
  }
</style>

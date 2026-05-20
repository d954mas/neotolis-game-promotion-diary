<script lang="ts">
  // MonthHeader — sticky month-group heading used on /games/[id] curated
  // events panel and on /feed.
  //
  // Visually quiet — month at --t-15 --w-sb in --text, count at --t-13
  // in --text-3 with --w-rg, separated by --border-hairline above, so
  // the chronological pool below it owns the page's attention.
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
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    margin: var(--s-6) 0 var(--s-2) 0;
    padding: var(--s-1) 0;
    border-top: 1px solid var(--border-hairline);
    position: sticky;
    top: 0;
    background: var(--bg);
    line-height: var(--lh-tight);
    min-width: 0;
  }
  .label {
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .count {
    font-family: var(--f-sans);
    font-size: var(--t-13);
    color: var(--text-3);
    font-weight: var(--w-rg);
  }
</style>

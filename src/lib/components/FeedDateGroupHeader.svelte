<script lang="ts">
  // FeedDateGroupHeader — date label between /feed card groups.
  //
  // Per prototype `docs/design/v2/ui-kit/index.html` `.date-head` rules
  // (lines 813-834): flex baseline-aligned row of h2 + monospace count
  // + horizontal rule taking the remaining width. Sticky below chrome.
  //
  // Renders BETWEEN feed-grids (one feed-grid per date), NOT inside a
  // grid. Compare: prototype renders `<DateGroupHeader />` followed by
  // its own `<div class="feed-grid">cards…</div>` per date.

  import { formatFeedDate } from "$lib/util/format-feed-date.js";

  let { occurredAt, count }: { occurredAt: Date | string; count: number } = $props();

  const label = $derived.by(() => {
    const raw = formatFeedDate(occurredAt);
    return raw.startsWith("Today") ? "Today" : raw;
  });

  const occurredIso = $derived(
    typeof occurredAt === "string" ? occurredAt : occurredAt.toISOString(),
  );
</script>

<div class="date-head">
  <h2><time datetime={occurredIso} title={occurredIso}>{label}</time></h2>
  <span class="count">{count}</span>
  <div class="rule" aria-hidden="true"></div>
</div>

<style>
  /* Mirrors prototype docs/design/v2/ui-kit/index.html .date-head rules
   * lines 813-821: sticky directly below the chrome (PageHead is NOT
   * sticky in the prototype — it scrolls with the page content). */
  .date-head {
    display: flex;
    align-items: baseline;
    gap: var(--s-3);
    padding: var(--s-6) 0 var(--s-3);
    position: sticky;
    top: calc(var(--chrome-height, 56px) - var(--sticky-overlap, 1px));
    background: var(--bg);
    z-index: 5;
  }
  .date-head:first-of-type {
    padding-top: 0;
  }
  h2 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    color: var(--text-2);
    letter-spacing: 0.01em;
  }
  .count {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border-hairline);
  }
</style>

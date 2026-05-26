<script lang="ts">
  // EventDetailStats — YouTube stats row (views/likes/comments) extracted
  // from EventDetailContent for maintainability.

  import { m } from "$lib/paraglide/messages.js";

  let {
    stats,
  }: {
    stats: { viewCount: number; likeCount: number; commentCount: number };
  } = $props();
</script>

<div class="detail-stats stats">
  <span class="detail-stat stat" title={m.event_detail_stat_views()}>
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
    <span class="detail-stat-num">{stats.viewCount.toLocaleString()}</span>
  </span>
  <span class="detail-stat stat" title={m.event_detail_stat_likes()}>
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
      />
    </svg>
    <span class="detail-stat-num">{stats.likeCount.toLocaleString()}</span>
  </span>
  <span class="detail-stat stat" title={m.event_detail_stat_comments()}>
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
    <span class="detail-stat-num">{stats.commentCount.toLocaleString()}</span>
  </span>
</div>

<style>
  .detail-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    padding: 4px 0;
    color: var(--text-3);
  }
  .detail-stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--t-13);
  }
  .detail-stat-num {
    color: var(--text);
    font-weight: var(--w-sb);
    font-variant-numeric: tabular-nums;
  }
</style>

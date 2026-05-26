<script lang="ts">
  // YouTube Ops panel for /admin.
  //
  // Mirrors RedditOpsPanel but reads from the YouTube slice of the shared
  // adapter_refresh_queue (adapter_kind='youtube_channel'). Two blocks:
  //   1. Queue depth per lane (user_video / service_video) — pending /
  //      processing / dead_letter + oldest-pending age.
  //   2. Daily breakdown — 24h done-row total + per-type counts + an
  //      all-time lifetime user_video counter so the operator sees the
  //      cumulative request volume alongside the 24h window.
  //
  // No "isConfigured" gate: YouTube is the original adapter and the
  // page always exposes its queue (operators without YouTube keys still
  // see a queue of zeros — useful signal that no work has run).

  import type {
    AdminYoutubeBlock,
    YoutubeQueueDepthRow,
  } from "$lib/server/services/admin-quota-read.js";

  let { data }: { data: AdminYoutubeBlock } = $props();

  function laneLabel(queueName: YoutubeQueueDepthRow["queueName"]): string {
    switch (queueName) {
      case "user_video":
        return "User-initiated refresh / paste";
      case "service_video":
        return "Cron / batch poller";
      default:
        return queueName;
    }
  }

  function formatAge(seconds: number | null): string {
    if (seconds === null) return "—";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m_ = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m_}m`;
  }

  let queueDepth = $derived(data.queueDepth);
  let daily = $derived(data.daily);
  let totalDeadLetter = $derived(queueDepth.reduce((sum, row) => sum + row.deadLetter, 0));
</script>

<div class="youtube-ops">
  <section class="youtube-ops__block">
    <h3>В очереди сейчас</h3>
    <p class="youtube-ops__intro">
      Pending / processing / dead-letter rows on adapter_refresh_queue, grouped by lane.
    </p>

    <table class="youtube-ops__table">
      <thead>
        <tr>
          <th>Lane</th>
          <th>Pending</th>
          <th>Processing</th>
          <th>Dead-letter</th>
          <th>Oldest pending</th>
        </tr>
      </thead>
      <tbody>
        {#each queueDepth as row (row.queueName)}
          <tr>
            <td data-label="Lane">
              <span class="youtube-ops__lane-name">{row.queueName}</span>
              <span class="youtube-ops__lane-desc">{laneLabel(row.queueName)}</span>
            </td>
            <td data-label="Pending" class="youtube-ops__num">{row.pending.toLocaleString()}</td>
            <td data-label="Processing" class="youtube-ops__num"
              >{row.processing.toLocaleString()}</td
            >
            <td
              data-label="Dead-letter"
              class="youtube-ops__num"
              class:youtube-ops__num--alarm={row.deadLetter > 0}
            >
              {row.deadLetter.toLocaleString()}
            </td>
            <td data-label="Oldest pending" class="youtube-ops__num">
              {formatAge(row.oldestPendingAgeSeconds)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if totalDeadLetter > 0}
      <p class="youtube-ops__alarm" role="alert">
        {totalDeadLetter} row(s) exhausted retries — manual review needed.
      </p>
    {/if}
  </section>

  <section class="youtube-ops__block">
    <h3>Объём запросов</h3>
    <p class="youtube-ops__intro">
      Done-rows aggregated from the shared queue. Each row ≈ one YouTube videos.list call.
    </p>

    <div class="youtube-ops__totals">
      <div class="youtube-ops__total-card">
        <span class="youtube-ops__total-num">{daily.total.toLocaleString()}</span>
        <span class="youtube-ops__total-label">за последние 24h</span>
      </div>
      <div class="youtube-ops__total-card">
        <span class="youtube-ops__total-num">{daily.lifetimeUserVideos.toLocaleString()}</span>
        <span class="youtube-ops__total-label">user-refresh всего за всё время</span>
      </div>
    </div>

    <table class="youtube-ops__table">
      <thead>
        <tr>
          <th>Type</th>
          <th>24h count</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-label="Type">
            <span class="youtube-ops__lane-name">video_stats</span>
            <span class="youtube-ops__lane-desc">Stats refresh (paste / refresh-now / cron)</span>
          </td>
          <td data-label="24h count" class="youtube-ops__num">
            {daily.byType.video_stats.toLocaleString()}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</div>

<style>
  /* v2 YoutubeOpsPanel — D-01 redraw via RedditOpsPanel analogy. */
  .youtube-ops {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-6);
  }
  .youtube-ops__block {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .youtube-ops__block h3 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .youtube-ops__intro {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    max-width: 60ch;
  }
  .youtube-ops__table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .youtube-ops__table th,
  .youtube-ops__table td {
    text-align: left;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--border-hairline);
    vertical-align: top;
    color: var(--text);
  }
  .youtube-ops__table th {
    font-weight: var(--w-md);
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .youtube-ops__num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .youtube-ops__num--alarm {
    color: var(--danger);
    font-weight: var(--w-sb);
  }
  .youtube-ops__lane-name {
    display: block;
    font-family: var(--f-mono);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    color: var(--text);
  }
  .youtube-ops__lane-desc {
    display: block;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    margin-top: 2px;
  }
  .youtube-ops__totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
  }
  .youtube-ops__total-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--s-3) var(--s-4);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    min-width: 12rem;
  }
  .youtube-ops__total-num {
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .youtube-ops__total-label {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  .youtube-ops__alarm {
    margin: var(--s-1) 0 0 0;
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    background: var(--surface-3);
    color: var(--danger);
    border: 1px solid var(--danger);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }

  @media (max-width: 600px) {
    .youtube-ops__table thead {
      display: none;
    }
    .youtube-ops__table,
    .youtube-ops__table tbody,
    .youtube-ops__table tr,
    .youtube-ops__table td {
      display: block;
      width: 100%;
    }
    .youtube-ops__table tr {
      padding: var(--s-2) 0;
      border-bottom: 1px solid var(--border);
    }
    .youtube-ops__table td {
      padding: 2px 0;
      border-bottom: none;
      text-align: left;
    }
    .youtube-ops__table td[data-label]::before {
      content: attr(data-label) ": ";
      color: var(--text-3);
      font-size: var(--t-12);
      margin-right: var(--s-1);
    }
    .youtube-ops__num {
      text-align: left;
    }
  }
</style>

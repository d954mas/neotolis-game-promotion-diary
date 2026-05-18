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
  .youtube-ops {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }
  .youtube-ops__block {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .youtube-ops__block h3 {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
  .youtube-ops__intro {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    max-width: 60ch;
  }
  .youtube-ops__table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-body);
  }
  .youtube-ops__table th,
  .youtube-ops__table td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }
  .youtube-ops__table th {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
  }
  .youtube-ops__num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .youtube-ops__num--alarm {
    color: var(--color-destructive);
    font-weight: var(--font-weight-semibold);
  }
  .youtube-ops__lane-name {
    display: block;
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }
  .youtube-ops__lane-desc {
    display: block;
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
    margin-top: 2px;
  }
  .youtube-ops__totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-md);
  }
  .youtube-ops__total-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    min-width: 12rem;
  }
  .youtube-ops__total-num {
    font-size: var(--font-size-h2, 1.5rem);
    font-weight: var(--font-weight-semibold);
    font-variant-numeric: tabular-nums;
  }
  .youtube-ops__total-label {
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
  }
  .youtube-ops__alarm {
    margin: var(--space-xs) 0 0 0;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
    color: var(--color-destructive);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
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
      padding: var(--space-sm) 0;
      border-bottom: 1px solid var(--color-border);
    }
    .youtube-ops__table td {
      padding: 2px 0;
      border-bottom: none;
      text-align: left;
    }
    .youtube-ops__table td[data-label]::before {
      content: attr(data-label) ": ";
      color: var(--color-text-muted);
      font-size: var(--font-size-small);
      margin-right: var(--space-xs);
    }
    .youtube-ops__num {
      text-align: left;
    }
  }
</style>

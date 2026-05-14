<script lang="ts">
  // Reddit Ops panel for /admin.
  //
  // Two blocks rendered side-by-side at desktop, stacked on mobile:
  //   1. "В очереди сейчас" — per-lane (queue_name) live snapshot of
  //      pending / processing / dead_letter counts + oldest-pending age.
  //   2. "Сегодня (24h)" — total processed + breakdown by handler `type`
  //      + alarm chips for cap_exhausted and adapter_degraded.
  //
  // When the operator hasn't configured REDDIT_USER_AGENT, the loader
  // returns `{ isConfigured: false }` and the panel renders a single
  // placeholder card (Reddit ingest disabled — see env docs).
  //
  // Mirrors the QuotaKeyTable layout idioms: plain <table>, no virt,
  // stacked-mobile via container-query-equivalent media break, status
  // colors via color-mix(in srgb, var(--color-X) 12%, transparent).

  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "./EmptyState.svelte";
  import type {
    AdminRedditBlock,
    RedditQueueDepthRow,
    RedditDailyByType,
  } from "$lib/server/services/admin-quota-read.js";

  let { data }: { data: AdminRedditBlock } = $props();

  // Lane labels — kept verbatim from the queue_name CHECK constraint
  // values. Paraglide messages map each to a human description.
  function laneLabel(queueName: RedditQueueDepthRow["queueName"]): string {
    switch (queueName) {
      case "service_source":
        return m.admin_reddit_lane_service_source();
      case "service_post":
        return m.admin_reddit_lane_service_post();
      case "user_source":
        return m.admin_reddit_lane_user_source();
      case "user_post":
        return m.admin_reddit_lane_user_post();
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

  function formatDegradedSince(d: Date | string | null): string {
    if (d === null) return "";
    const ts = typeof d === "string" ? new Date(d) : d;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000));
    return formatAge(ageSeconds);
  }

  // Derived totals — only meaningful when configured.
  let configured = $derived(data.isConfigured);
  let queueDepth = $derived(data.isConfigured ? data.queueDepth : []);
  let daily: RedditDailyByType | null = $derived(data.isConfigured ? data.daily : null);
  let totalDeadLetter = $derived(queueDepth.reduce((sum, row) => sum + row.deadLetter, 0));
</script>

{#if !configured}
  <EmptyState heading={m.admin_reddit_disabled_heading()} body={m.admin_reddit_disabled_body()} />
{:else}
  <div class="reddit-ops">
    <!-- Block 1: В очереди сейчас -->
    <section class="reddit-ops__block">
      <h3>{m.admin_reddit_queue_block_title()}</h3>
      <p class="reddit-ops__intro">{m.admin_reddit_queue_block_intro()}</p>

      <table class="reddit-ops__table">
        <thead>
          <tr>
            <th>{m.admin_reddit_col_lane()}</th>
            <th>{m.admin_reddit_col_pending()}</th>
            <th>{m.admin_reddit_col_processing()}</th>
            <th>{m.admin_reddit_col_dead_letter()}</th>
            <th>{m.admin_reddit_col_oldest()}</th>
          </tr>
        </thead>
        <tbody>
          {#each queueDepth as row (row.queueName)}
            <tr>
              <td data-label={m.admin_reddit_col_lane()}>
                <span class="reddit-ops__lane-name">{row.queueName}</span>
                <span class="reddit-ops__lane-desc">{laneLabel(row.queueName)}</span>
              </td>
              <td data-label={m.admin_reddit_col_pending()} class="reddit-ops__num">
                {row.pending.toLocaleString()}
              </td>
              <td data-label={m.admin_reddit_col_processing()} class="reddit-ops__num">
                {row.processing.toLocaleString()}
              </td>
              <td
                data-label={m.admin_reddit_col_dead_letter()}
                class="reddit-ops__num"
                class:reddit-ops__num--alarm={row.deadLetter > 0}
              >
                {row.deadLetter.toLocaleString()}
              </td>
              <td data-label={m.admin_reddit_col_oldest()} class="reddit-ops__num">
                {formatAge(row.oldestPendingAgeSeconds)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if totalDeadLetter > 0}
        <p class="reddit-ops__alarm" role="alert">
          {m.admin_reddit_dead_letter_alarm({ count: totalDeadLetter })}
        </p>
      {/if}
    </section>

    <!-- Block 2: Сегодня (24h) -->
    <section class="reddit-ops__block">
      <h3>{m.admin_reddit_daily_block_title()}</h3>
      <p class="reddit-ops__intro">{m.admin_reddit_daily_block_intro()}</p>

      {#if daily}
        <p class="reddit-ops__total">
          <span class="reddit-ops__total-num">{daily.total.toLocaleString()}</span>
          <span class="reddit-ops__total-label">{m.admin_reddit_daily_total_label()}</span>
        </p>

        <table class="reddit-ops__table">
          <thead>
            <tr>
              <th>{m.admin_reddit_col_type()}</th>
              <th>{m.admin_reddit_col_count()}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label={m.admin_reddit_col_type()}>
                <span class="reddit-ops__lane-name">sub_poll</span>
                <span class="reddit-ops__lane-desc">{m.admin_reddit_type_sub_poll()}</span>
              </td>
              <td data-label={m.admin_reddit_col_count()} class="reddit-ops__num">
                {daily.byType.sub_poll.toLocaleString()}
              </td>
            </tr>
            <tr>
              <td data-label={m.admin_reddit_col_type()}>
                <span class="reddit-ops__lane-name">author_poll</span>
                <span class="reddit-ops__lane-desc">{m.admin_reddit_type_author_poll()}</span>
              </td>
              <td data-label={m.admin_reddit_col_count()} class="reddit-ops__num">
                {daily.byType.author_poll.toLocaleString()}
              </td>
            </tr>
            <tr>
              <td data-label={m.admin_reddit_col_type()}>
                <span class="reddit-ops__lane-name">post_single</span>
                <span class="reddit-ops__lane-desc">{m.admin_reddit_type_post_single()}</span>
              </td>
              <td data-label={m.admin_reddit_col_count()} class="reddit-ops__num">
                {daily.byType.post_single.toLocaleString()}
              </td>
            </tr>
            <tr>
              <td data-label={m.admin_reddit_col_type()}>
                <span class="reddit-ops__lane-name">post_batch</span>
                <span class="reddit-ops__lane-desc">{m.admin_reddit_type_post_batch()}</span>
              </td>
              <td data-label={m.admin_reddit_col_count()} class="reddit-ops__num">
                {daily.byType.post_batch.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>

        {#if daily.capExhaustedCount > 0 || daily.adapterDegradedSince}
          <ul class="reddit-ops__alarms">
            {#if daily.capExhaustedCount > 0}
              <li class="reddit-ops__alarm-chip">
                {m.admin_reddit_cap_exhausted_chip({ count: daily.capExhaustedCount })}
              </li>
            {/if}
            {#if daily.adapterDegradedSince}
              <li class="reddit-ops__alarm-chip reddit-ops__alarm-chip--degraded">
                {m.admin_reddit_adapter_degraded_chip({
                  age: formatDegradedSince(daily.adapterDegradedSince),
                })}
              </li>
            {/if}
          </ul>
        {/if}
      {/if}
    </section>
  </div>
{/if}

<style>
  .reddit-ops {
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }
  .reddit-ops__block {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .reddit-ops__block h3 {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
  .reddit-ops__intro {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    max-width: 60ch;
  }
  .reddit-ops__table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-body);
  }
  .reddit-ops__table th,
  .reddit-ops__table td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }
  .reddit-ops__table th {
    font-weight: var(--font-weight-medium);
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
  }
  .reddit-ops__num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .reddit-ops__num--alarm {
    color: var(--color-destructive);
    font-weight: var(--font-weight-semibold);
  }
  .reddit-ops__lane-name {
    display: block;
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }
  .reddit-ops__lane-desc {
    display: block;
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
    margin-top: 2px;
  }
  .reddit-ops__total {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: var(--space-sm);
  }
  .reddit-ops__total-num {
    font-size: var(--font-size-h2, 1.5rem);
    font-weight: var(--font-weight-semibold);
    font-variant-numeric: tabular-nums;
  }
  .reddit-ops__total-label {
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
  }
  .reddit-ops__alarm {
    margin: var(--space-xs) 0 0 0;
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
    color: var(--color-destructive);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }
  .reddit-ops__alarms {
    margin: var(--space-xs) 0 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
  }
  .reddit-ops__alarm-chip {
    padding: 2px var(--space-sm);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--color-info, var(--color-text-muted)) 12%, transparent);
    color: var(--color-info, var(--color-text));
    font-size: var(--font-size-small);
  }
  .reddit-ops__alarm-chip--degraded {
    background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
    color: var(--color-destructive);
    font-weight: var(--font-weight-medium);
  }

  /* Stacked layout on narrow viewports. */
  @media (max-width: 600px) {
    .reddit-ops__table thead {
      display: none;
    }
    .reddit-ops__table,
    .reddit-ops__table tbody,
    .reddit-ops__table tr,
    .reddit-ops__table td {
      display: block;
      width: 100%;
    }
    .reddit-ops__table tr {
      padding: var(--space-sm) 0;
      border-bottom: 1px solid var(--color-border);
    }
    .reddit-ops__table td {
      padding: 2px 0;
      border-bottom: none;
      text-align: left;
    }
    .reddit-ops__table td[data-label]::before {
      content: attr(data-label) ": ";
      color: var(--color-text-muted);
      font-size: var(--font-size-small);
      margin-right: var(--space-xs);
    }
    .reddit-ops__num {
      text-align: left;
    }
  }
</style>

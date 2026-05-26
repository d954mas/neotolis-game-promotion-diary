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

  function formatPauseUntil(d: Date | string | null): string {
    if (d === null) return "";
    const ts = typeof d === "string" ? new Date(d) : d;
    return ts.toLocaleString();
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
        <div class="reddit-ops__totals">
          <div class="reddit-ops__total-card">
            <span class="reddit-ops__total-num">{daily.total.toLocaleString()}</span>
            <span class="reddit-ops__total-label">за последние 24h</span>
          </div>
          <div class="reddit-ops__total-card">
            <span class="reddit-ops__total-num">{daily.lifetimeTotal.toLocaleString()}</span>
            <span class="reddit-ops__total-label">за последние 7 дней</span>
            <span class="reddit-ops__total-hint"> done-строки очереди чистятся через 7 дней </span>
          </div>
        </div>

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
          </tbody>
        </table>

        {#if daily.capExhaustedCount > 0 || daily.adapterDegradedSince || daily.adapterPausedUntil}
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
            {#if daily.adapterPausedUntil}
              <li class="reddit-ops__alarm-chip reddit-ops__alarm-chip--degraded">
                {m.admin_reddit_adapter_paused_chip({
                  time: formatPauseUntil(daily.adapterPausedUntil),
                  reason: daily.adapterPauseReason ?? "rate-limit",
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
  /* v2 RedditOpsPanel — D-01 redraw via admin-panel pattern: --surface-2
   * + --border + --r-md container with form/table sections. */
  .reddit-ops {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-6);
  }
  .reddit-ops__block {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .reddit-ops__block h3 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .reddit-ops__intro {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    max-width: 60ch;
  }
  .reddit-ops__table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .reddit-ops__table th,
  .reddit-ops__table td {
    text-align: left;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--border-hairline);
    vertical-align: top;
    color: var(--text);
  }
  .reddit-ops__table th {
    font-weight: var(--w-md);
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .reddit-ops__num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .reddit-ops__num--alarm {
    color: var(--danger);
    font-weight: var(--w-sb);
  }
  .reddit-ops__lane-name {
    display: block;
    font-family: var(--f-mono);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    color: var(--text);
  }
  .reddit-ops__lane-desc {
    display: block;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    margin-top: 2px;
  }
  .reddit-ops__totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
  }
  .reddit-ops__total-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--s-3) var(--s-4);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    min-width: 12rem;
  }
  .reddit-ops__total-num {
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .reddit-ops__total-label {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  .reddit-ops__total-hint {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    opacity: 0.7;
    margin-top: 2px;
  }
  .reddit-ops__alarm {
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
  .reddit-ops__alarms {
    margin: var(--s-1) 0 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .reddit-ops__alarm-chip {
    padding: var(--s-0) var(--s-2);
    border-radius: var(--r-pill);
    background: var(--surface-3);
    color: var(--info);
    border: 1px solid var(--info);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  .reddit-ops__alarm-chip--degraded {
    background: var(--surface-3);
    color: var(--danger);
    border-color: var(--danger);
    font-weight: var(--w-md);
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
      padding: var(--s-2) 0;
      border-bottom: 1px solid var(--border);
    }
    .reddit-ops__table td {
      padding: 2px 0;
      border-bottom: none;
      text-align: left;
    }
    .reddit-ops__table td[data-label]::before {
      content: attr(data-label) ": ";
      color: var(--text-3);
      font-size: var(--t-12);
      margin-right: var(--s-1);
    }
    .reddit-ops__num {
      text-align: left;
    }
  }
</style>

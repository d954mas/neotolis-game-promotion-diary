<script lang="ts">
  // Per-API-key quota usage table.
  //
  // Renders the operator's view of today's youtube_service_quota_usage rows
  // (sourced from /api/admin/quota). Four columns:
  //   1. Key id      (sha-8 hash from admin-quota-read.toQuotaKeyRow)
  //   2. Units used  (estimatedUnits, locale-formatted)
  //   3. % of 10 000 (pctOfDaily, 1 decimal)
  //   4. Status      (pill: OK · 80% throttle — Cold paused · 95% throttle — Active paused)
  //
  // UI contract:
  //   - Plain <table> (no virtualization — N keys is bounded by
  //     SERVICE_YOUTUBE_API_KEYS.length, typically 1–3 per Google ToS limits).
  //   - Status pill is the ONLY admin-side place where the Throttled
  //     PollingBadge variant copy surfaces. Status colors:
  //       OK         → success (green) at 12% alpha + success text
  //       80_throttle → info    (cyan)  at 12% alpha + info text
  //       95_throttle → destructive (red) at 12% alpha + destructive text
  //     Alpha via color-mix(in srgb, var(--color-X) 12%, transparent) —
  //     idiom shared with RetentionBadge warning state.
  //   - Stacked layout < 600px viewport (no horizontal scroll); thead
  //     hides, each row collapses to a 2-column grid (key id full-width,
  //     details + status pill below).
  //   - Empty state via shared <EmptyState> when rows.length === 0.

  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "./EmptyState.svelte";

  type StatusKey = "ok" | "80_throttle" | "95_throttle";

  export type QuotaKeyRow = {
    apiKeyId: string;
    estimatedUnits: number;
    pctOfDaily: number;
    status: StatusKey;
  };

  let { rows }: { rows: QuotaKeyRow[] } = $props();

  function statusLabel(s: StatusKey): string {
    switch (s) {
      case "ok":
        return m.admin_quota_status_ok();
      case "80_throttle":
        return m.admin_quota_status_80_throttle();
      case "95_throttle":
        return m.admin_quota_status_95_throttle();
    }
  }
</script>

{#if rows.length === 0}
  <EmptyState heading={m.admin_quota_keys_empty_heading()} body={m.admin_quota_keys_empty_body()} />
{:else}
  <table class="quota-key-table">
    <thead>
      <tr>
        <th>{m.admin_quota_table_col_key_id()}</th>
        <th>{m.admin_quota_table_col_units_used()}</th>
        <th>{m.admin_quota_table_col_pct_of_daily()}</th>
        <th>{m.admin_quota_table_col_status()}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.apiKeyId)}
        <tr>
          <td><code>{r.apiKeyId}</code></td>
          <td>{r.estimatedUnits.toLocaleString()}</td>
          <td>{r.pctOfDaily.toFixed(1)}%</td>
          <td>
            <span class="status-pill status-pill--{r.status}">{statusLabel(r.status)}</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  /* v2 QuotaKeyTable — 4-col table with --surface-2 thead and
   * --border-hairline row separators; tabular-nums for the numeric cells.
   * Status pills as --r-pill chips with v2 semantic colors. Phase 03.0
   * plan 13 contract — < 600px stacking — preserved. */
  .quota-key-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
    min-width: 0;
  }
  .quota-key-table th,
  .quota-key-table td {
    text-align: left;
    padding: var(--s-3);
    border-bottom: 1px solid var(--border-hairline);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .quota-key-table tr:last-child td {
    border-bottom: none;
  }
  .quota-key-table th {
    font-weight: var(--w-md);
    color: var(--text-3);
    background: var(--surface-2);
  }
  .quota-key-table code {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text);
  }

  /* QuotaKeyTable status pill — --r-pill chip with semantic color wash. */
  .status-pill {
    display: inline-block;
    padding: var(--s-0) var(--s-2);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    white-space: nowrap;
  }
  .status-pill--ok {
    background: var(--accent-soft);
    color: var(--success);
  }
  .status-pill--80_throttle {
    background: var(--surface-2);
    color: var(--warn);
    border: 1px solid var(--warn);
  }
  .status-pill--95_throttle {
    background: var(--danger);
    color: #fff;
  }

  /* Stacked layout < 600px viewport — Phase 03.0 plan 13 contract preserved. */
  @media (max-width: 600px) {
    .quota-key-table thead {
      display: none;
    }
    .quota-key-table,
    .quota-key-table tbody,
    .quota-key-table tr {
      display: block;
    }
    .quota-key-table tr {
      display: grid;
      grid-template-columns: 1fr auto;
      column-gap: var(--s-2);
      row-gap: var(--s-1);
      padding: var(--s-3);
      border-bottom: 1px solid var(--border);
    }
    .quota-key-table td {
      border-bottom: none;
      padding: 0;
    }
    .quota-key-table td:first-child {
      grid-column: 1 / 3;
      font-weight: var(--w-sb);
    }
    .status-pill {
      justify-self: end;
    }
  }
</style>

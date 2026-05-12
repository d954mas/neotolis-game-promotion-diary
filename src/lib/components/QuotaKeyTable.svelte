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
  .quota-key-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-label);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .quota-key-table th,
  .quota-key-table td {
    text-align: left;
    padding: var(--space-md) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }
  .quota-key-table tr:last-child td {
    border-bottom: none;
  }
  .quota-key-table th {
    font-weight: var(--font-weight-regular);
    color: var(--color-text-muted);
  }
  .quota-key-table code {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-label);
    color: var(--color-text);
  }

  /* QuotaKeyTable status pill color rules: 12% alpha wash via color-mix
   * (the RetentionBadge idiom). */
  .status-pill {
    display: inline-block;
    padding: 2px var(--space-sm);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
  }
  .status-pill--ok {
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
    color: var(--color-success);
  }
  .status-pill--80_throttle {
    background: color-mix(in srgb, var(--color-info) 12%, transparent);
    color: var(--color-info);
  }
  .status-pill--95_throttle {
    background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
    color: var(--color-destructive);
  }

  /* Stacked layout < 600px viewport: columns collapse so each row becomes
   * a vertical block (key id on first line, units used + % + status pill
   * below). Status pill stays right-aligned. */
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
      column-gap: var(--space-sm);
      row-gap: var(--space-xs);
      padding: var(--space-md);
      border-bottom: 1px solid var(--color-border);
    }
    .quota-key-table td {
      border-bottom: none;
      padding: 0;
    }
    .quota-key-table td:first-child {
      grid-column: 1 / 3;
      font-weight: var(--font-weight-semibold);
    }
    .status-pill {
      justify-self: end;
    }
  }
</style>

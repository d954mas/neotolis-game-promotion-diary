<script lang="ts">
  // Service-level audit list (last 50 entries).
  //
  // Visually mirrors <AuditRow> from /audit but reads SERVICE-LEVEL audit
  // verbs (quota.service_throttled / purge.completed / auto_import.deferred /
  // poll.failed) instead of the per-tenant /audit feed. Sourced from
  // /api/admin/quota response.audit.
  //
  // UI contract:
  //   - <ul> (semantic list) of <li> entries.
  //   - Each entry: <time datetime=...> · <code>{action}</code> · metadata
  //     summary (compact one-line; operator can drill into full audit log
  //     via /audit elsewhere if needed).
  //   - NOT cursor-paginated (last-50 is the spec).
  //   - Empty state via <EmptyState> when entries.length === 0.
  //   - Same dense-table aesthetic as <AuditRow>: no accent fills, every
  //     row reads identically regardless of action verb (color-coding
  //     verbs would imply some are more important — we don't make that
  //     claim here).
  //
  // Date formatting note: locale-fixed ISO ("YYYY-MM-DD HH:MM:SS") for SSR
  // consistency. The full ISO timestamp lives in the <time datetime=> attr
  // for screen readers / browser tooling. /audit uses toLocaleString()
  // because it shows per-user data; here the operator views cross-tenant
  // service signals where a stable wall-clock format aids correlation
  // across log sources.

  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "./EmptyState.svelte";

  export type ServiceAuditEntry = {
    id: string;
    createdAt: Date | string;
    action: string;
    metadata: Record<string, unknown>;
  };

  let { entries }: { entries: ServiceAuditEntry[] } = $props();

  function isoString(d: Date | string): string {
    return typeof d === "string" ? d : d.toISOString();
  }

  function fmt(d: Date | string): string {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().slice(0, 19).replace("T", " ");
  }

  function metadataSummary(meta: Record<string, unknown>): string {
    const keys = Object.keys(meta);
    if (keys.length === 0) return "";
    return keys
      .slice(0, 3)
      .map((k) => `${k}=${JSON.stringify(meta[k])}`)
      .join(" · ");
  }
</script>

{#if entries.length === 0}
  <EmptyState
    heading={m.admin_quota_audit_empty_heading()}
    body={m.admin_quota_audit_empty_body()}
  />
{:else}
  <ul class="quota-audit-list">
    {#each entries as e (e.id)}
      <li class="quota-audit-row">
        <time datetime={isoString(e.createdAt)}>{fmt(e.createdAt)}</time>
        <code class="action">{e.action}</code>
        <span class="meta">{metadataSummary(e.metadata)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  /* v2 QuotaAuditList — D-01 redraw via AuditRow analogy. */
  .quota-audit-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .quota-audit-row {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    background: var(--surface-2);
    border-bottom: 1px solid var(--border-hairline);
    align-items: baseline;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    min-width: 0;
  }
  .quota-audit-row:last-child {
    border-bottom: none;
  }
  .quota-audit-row time {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
    white-space: nowrap;
  }
  .quota-audit-row .action {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text);
  }
  .quota-audit-row .meta {
    color: var(--text-3);
    font-size: var(--t-12);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Each entry stacks vertically below 600px. */
  @media (max-width: 600px) {
    .quota-audit-row {
      grid-template-columns: 1fr;
      gap: var(--s-1);
      padding: var(--s-3);
    }
    .quota-audit-row .meta {
      white-space: normal;
    }
  }
</style>

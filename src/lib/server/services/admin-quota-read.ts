// Admin /admin/quota loader.
//
// Service-layer reader (no Hono, no auth concerns): the route at
// `src/lib/server/http/routes/admin/quota.ts` calls
// `loadAdminQuotaPage()` after the auth + allowlist gates have fired.
// Returns the operator's view of today's per-key quota usage plus a tail
// of service-level audit rows.
//
// Allowlist-gated CROSS-TENANT reads:
//   The audit_log lookup intentionally aggregates across tenants.
//   /admin/quota is the operator's signal pane — they need to see purges
//   across all tenants, quota throttle transitions tied to the
//   operator's API keys, and adapter-level auto-import deferrals
//   regardless of which tenant triggered them. The security property is
//   the env allowlist: a non-allowlisted user never reaches this loader
//   (admin middleware throws NotFoundError before the route handler
//   runs). The audit_log table is in ESLint's TENANT_TABLES; the
//   cross-tenant query below carries an `eslint-disable-next-line` with
//   a `--` justification.
//
// Threshold derivation:
//   pctOfDaily = estimatedUnits / dailyLimit * 100, rounded to 1 decimal.
//   status: derived from per-key `throttleState` returned by the
//     adapter's observability surface
//     (`getDailyStats(now).keys[].throttleState`):
//       'ok'                    → status 'ok'
//       'eighty'                → status '80_throttle'
//       'ninetyfive'            → status '95_throttle'
//   Per-platform threshold values are an adapter-internal concern so
//   different source adapters can use their own (e.g. rolling-window)
//   thresholds without touching this loader.

import { desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import type { AuditAction } from "../audit/actions.js";
import { todayPacific } from "./quota.js";
import { getAdapter } from "$lib/sources/registry.js";

export interface QuotaKeyRow {
  /** sha-8 hash of the operator's API key — stable identifier across boots. */
  apiKeyId: string;
  /** Estimated quota units consumed by this key today (Pacific). */
  estimatedUnits: number;
  /** estimatedUnits / dailyLimit * 100, rounded to 1 decimal. */
  pctOfDaily: number;
  /** UI status pill — translated from adapter's per-key throttleState. */
  status: "ok" | "80_throttle" | "95_throttle";
}

export interface ServiceAuditEntry {
  id: string;
  createdAt: Date;
  /** One of SERVICE_LEVEL_AUDIT_ACTIONS — the verbs surfaced on /admin/quota. */
  action: string;
  metadata: Record<string, unknown>;
}

/**
 * The audit verbs surfaced on /admin/quota — operator-facing signals
 * only. Per-tenant audit rows (session.signin / event.created / ...)
 * are NOT surfaced here; users see those in their own /audit page.
 */
const SERVICE_LEVEL_AUDIT_ACTIONS: readonly AuditAction[] = [
  "quota.service_throttled",
  "purge.completed",
  "auto_import.deferred",
  "poll.failed",
] as const;

/** How many tail audit rows to surface on /admin/quota. */
const ADMIN_AUDIT_TAIL_LIMIT = 50;

export async function loadAdminQuotaPage(): Promise<{
  today: string;
  keys: QuotaKeyRow[];
  audit: ServiceAuditEntry[];
}> {
  const today = todayPacific();
  const now = new Date();

  // Kind-decoupled key read via the adapter's observability surface.
  // Routes through getAdapter("youtube_channel").observability.quota.getDailyStats
  // so the /admin/quota page is decoupled from YouTube-specific schema.
  // Adding new sources extends this loader by iterating adapters that
  // surface observability, not by editing kind-specific reads.
  //
  // The `keys` projection still uses the existing { apiKeyId,
  // estimatedUnits, pctOfDaily (0-100 percent), status } shape for
  // backward compatibility with the /admin route + UI; the observability
  // stats surface returns a richer shape (unitsUsed total / dailyLimit /
  // pct fraction / throttleState) that we adapt at projection time.
  const stats = await getAdapter("youtube_channel").observability.quota.getDailyStats(now);

  // Per-key projection — convert observability stats.keys[] to
  // QuotaKeyRow[]. The keys array carries one entry per apiKeyId with
  // today's estimatedUnits AND a throttleState classification computed
  // by the adapter. Cross-source admin-read no longer hardcodes
  // thresholds — it trusts the adapter's per-key state.
  const keyRows: QuotaKeyRow[] = (stats.keys ?? []).map((k) =>
    toQuotaKeyRowFromObservability(k.apiKeyId, k.unitsUsed, k.throttleState, stats.dailyLimit),
  );

  // Audit aggregation is intentionally CROSS-SOURCE — it surfaces
  // purge.completed / auto_import.deferred / poll.failed (cross-cutting
  // verbs not owned by any single adapter) alongside
  // quota.service_throttled. The adapter's
  // observability.quota.getRecentAudit only carries YouTube-specific
  // verbs by contract; aggregating here keeps the operator's "what
  // crossed our system today" pane complete. The eslint-disable below
  // is justified — admin allowlist is the gate, not row-level userId.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Adding a userId filter here would defeat the operator's signal pane (purges, quota transitions, adapter deferrals all live across tenants).
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.action, SERVICE_LEVEL_AUDIT_ACTIONS))
    .orderBy(desc(auditLog.createdAt))
    .limit(ADMIN_AUDIT_TAIL_LIMIT);

  return {
    today,
    keys: keyRows,
    audit: auditRows.map(toServiceAuditEntry),
  };
}

/**
 * Convert an observability key entry { apiKeyId, unitsUsed, throttleState }
 * to the legacy QuotaKeyRow shape (pctOfDaily as 0-100 percent + status pill).
 *
 * `throttleState` is computed by the adapter (per-platform thresholds).
 * This function only translates between observability shape
 * (`'ok' | 'eighty' | 'ninetyfive'`) and admin wire-format (`'ok' |
 * '80_throttle' | '95_throttle'`); it does not recompute thresholds.
 *
 * `dailyLimit` is the per-platform single-key budget used for the percent
 * denominator (YouTube = 10000). Falling back to 10000 keeps the legacy wire
 * format stable for the existing test + UI assertions.
 */
function toQuotaKeyRowFromObservability(
  apiKeyId: string,
  unitsUsed: number,
  throttleState: "ok" | "eighty" | "ninetyfive",
  dailyLimit: number,
): QuotaKeyRow {
  // 1 decimal — multiply by 1000, round, divide by 10. Float-safe at quota
  // scale (worst case: 99_999 / 10_000 * 100 = 999.99 → rounded 1000.0).
  const denom = dailyLimit > 0 ? dailyLimit : 10_000;
  const pct = Math.round((unitsUsed / denom) * 1000) / 10;
  const status: QuotaKeyRow["status"] =
    throttleState === "ninetyfive"
      ? "95_throttle"
      : throttleState === "eighty"
        ? "80_throttle"
        : "ok";
  return {
    apiKeyId,
    estimatedUnits: unitsUsed,
    pctOfDaily: pct,
    status,
  };
}

/**
 * DTO projection for service-level audit_log rows. Mirrors toAuditEntryDto
 * shape but includes the row id for de-dup on the client (the tail is
 * paginated-cap-only; clients re-query, no cursor needed at this scale).
 *
 * We intentionally do NOT project user_id even though the lookup is
 * cross-tenant — the operator UI shows verb + metadata + time only. If a
 * future operator screen needs the per-tenant id (e.g. for "which tenant
 * triggered this purge?") add the field explicitly with the same review
 * touchpoint discipline as the rest of dto.ts.
 */
export function toServiceAuditEntry(row: typeof auditLog.$inferSelect): ServiceAuditEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

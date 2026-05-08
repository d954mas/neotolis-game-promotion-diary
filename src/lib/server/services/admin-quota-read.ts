// Phase 3.0 Plan 07 — admin /admin/quota loader (D-16 + DV-3).
//
// Service-layer reader (no Hono, no auth concerns): the route at
// `src/lib/server/http/routes/admin/quota.ts` calls `loadAdminQuotaPage()`
// after the auth + allowlist gates have fired. Returns the operator's view
// of today's per-key quota usage plus a tail of service-level audit rows.
//
// Allowlist-gated CROSS-TENANT reads:
//   The audit_log lookup intentionally aggregates across tenants. /admin/quota
//   is the operator's signal pane — they need to see purges across all
//   tenants, quota throttle transitions tied to the operator's API keys, and
//   adapter-level auto-import deferrals regardless of which tenant triggered
//   them. The security property is the env allowlist: a non-allowlisted user
//   never reaches this loader (admin middleware throws NotFoundError before
//   the route handler runs). Per AGENTS.md the audit_log table is in
//   ESLint's TENANT_TABLES; the cross-tenant query below carries an
//   `eslint-disable-next-line` with a `--` justification per AGENTS.md
//   pitfall-7 convention.
//
// Threshold derivation:
//   pctOfDaily = estimatedUnits / 10_000 * 100, rounded to 1 decimal.
//   status:
//     'ok'           when estimatedUnits <  THROTTLE_EIGHTY_THRESHOLD     (8000)
//     '80_throttle'  when 8000 <= estimatedUnits < 9500
//     '95_throttle'  when estimatedUnits >= THROTTLE_NINETYFIVE_THRESHOLD  (9500)
//   The threshold constants live alongside the function that consumes them
//   (Plan 03 — $lib/sources/youtube/server/quota.ts). Re-import here so the magic literals
//   exist in only one place.

import { desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { youtubeServiceQuotaUsage } from "../db/schema/index.js";
import { auditLog } from "../db/schema/audit-log.js";
import type { AuditAction } from "../audit/actions.js";
import {
  THROTTLE_EIGHTY_THRESHOLD,
  THROTTLE_NINETYFIVE_THRESHOLD,
  todayPacific,
} from "$lib/sources/youtube/server/quota.js";
import { getAdapter } from "$lib/sources/registry.js";

export interface QuotaKeyRow {
  /** sha-8 hash of the operator's API key — stable identifier across boots. */
  apiKeyId: string;
  /** Estimated YouTube quota units consumed by this key today (Pacific). */
  estimatedUnits: number;
  /** estimatedUnits / 10_000 * 100, rounded to 1 decimal. */
  pctOfDaily: number;
  /** UI status pill — driven by the same THROTTLE_*_THRESHOLD as the scheduler. */
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
 * The audit verbs surfaced on /admin/quota — operator-facing signals only.
 * Per-tenant audit rows (session.signin / event.created / ...) are NOT
 * surfaced here; users see those in their own /audit page (PRIV-02).
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

  // Phase 03.0.1 Plan 08 (D-08) — kind-decoupled key read via the adapter's
  // observability surface. Pre-Plan-08 this loader queried
  // youtube_service_quota_usage directly; Plan 08 routes through
  // getAdapter("youtube_channel").observability.quota.getDailyStats so the
  // /admin/quota page is decoupled from YouTube-specific schema. Adding
  // Reddit / Twitter etc. in Phase 03.1+ extends this loader by iterating
  // adapters that surface observability, not by editing kind-specific reads.
  //
  // The `keys` projection still uses the existing { apiKeyId,
  // estimatedUnits, pctOfDaily (0-100 percent), status } shape for backward
  // compatibility with the /admin route + UI; the observability stats
  // surface returns a richer shape (unitsUsed total / dailyLimit / pct
  // fraction / throttleState) that we adapt at projection time. The
  // existing tests/integration/admin-quota.test.ts assertions hold.
  const stats = await getAdapter("youtube_channel").observability.quota.getDailyStats(now);

  // Per-key projection — convert observability stats.keys[] to QuotaKeyRow[].
  // The keys array carries one entry per apiKeyId with today's estimatedUnits;
  // status thresholds match the scheduler (THROTTLE_*_THRESHOLD constants).
  const keyRows: QuotaKeyRow[] = (stats.keys ?? []).map((k) =>
    toQuotaKeyRowFromObservability(k.apiKeyId, k.unitsUsed),
  );

  // Audit aggregation is intentionally CROSS-SOURCE — it surfaces
  // purge.completed / auto_import.deferred / poll.failed (cross-cutting
  // verbs not owned by any single adapter) alongside quota.service_throttled
  // (YouTube-specific). The adapter's observability.quota.getRecentAudit
  // only carries YouTube-specific verbs by D-08 contract; aggregating
  // here keeps the operator's "what crossed our system today" pane
  // complete. The eslint-disable below is the same security justification
  // as pre-Plan-08 — admin allowlist is the gate, not row-level userId.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota is allowlist-gated; cross-tenant audit aggregation is the intended operator view (CONTEXT D-16 / DV-3 / Open Question 4 in 03.0-RESEARCH.md). Adding a userId filter here would defeat the operator's signal pane (purges, quota transitions, adapter deferrals all live across tenants).
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
 * Plan 08 — convert an observability key entry { apiKeyId, unitsUsed } to
 * the legacy QuotaKeyRow shape (pctOfDaily as 0-100 percent + status pill).
 * The observability surface returns the richer shape (fraction + verbose
 * throttleState); the /admin/quota wire format stays as the legacy
 * percent + 'ok'|'80_throttle'|'95_throttle' pill for backward
 * compatibility with the integration test + UI.
 */
function toQuotaKeyRowFromObservability(apiKeyId: string, unitsUsed: number): QuotaKeyRow {
  // 1 decimal — multiply by 1000, round, divide by 10. Float-safe at quota
  // scale (worst case: 99_999 / 10_000 * 100 = 999.99 → rounded 1000.0).
  const pct = Math.round((unitsUsed / 10_000) * 1000) / 10;
  const status: QuotaKeyRow["status"] =
    unitsUsed >= THROTTLE_NINETYFIVE_THRESHOLD
      ? "95_throttle"
      : unitsUsed >= THROTTLE_EIGHTY_THRESHOLD
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
 * DTO projection for `youtube_service_quota_usage` rows surfaced on
 * /admin/quota. Computes pctOfDaily + status using the SAME thresholds the
 * scheduler uses (single source of truth — $lib/sources/youtube/server/quota.ts exports).
 */
export function toQuotaKeyRow(row: typeof youtubeServiceQuotaUsage.$inferSelect): QuotaKeyRow {
  const u = row.estimatedUnits;
  // 1 decimal — multiply by 1000, round, divide by 10. Float-safe at quota
  // scale (worst case: 99_999 / 10_000 * 100 = 999.99 → rounded 1000.0).
  const pct = Math.round((u / 10_000) * 1000) / 10;
  const status: QuotaKeyRow["status"] =
    u >= THROTTLE_NINETYFIVE_THRESHOLD
      ? "95_throttle"
      : u >= THROTTLE_EIGHTY_THRESHOLD
        ? "80_throttle"
        : "ok";
  return {
    apiKeyId: row.apiKeyId,
    estimatedUnits: u,
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

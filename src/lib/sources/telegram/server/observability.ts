// Telegram adapter observability.
//
// Telegram is a FREE public-scrape source — there is NO secret, NO daily quota
// cap, NO operator budget. So this surface is the minimal AdapterObservability
// the /admin/quota cross-source dashboard contract requires, with the
// quota/cost machinery stripped:
//
//   - auth: kind="scrape", requiresUserSetup=false, isOperatorConfigured=true
//     ALWAYS. There is nothing to configure (no API key / OAuth app / env
//     secret), so the adapter is never "unconfigured". This is the structural
//     difference from Reddit (gates on REDDIT_USER_AGENT) and IG (gates on a
//     provider key) — Telegram has no gate.
//
//   - quota.getDailyStats(date): there is no daily cap, so dailyLimit=0 and
//     throttleState is always "ok". unitsUsed is a synthetic 24h count of
//     drained Telegram lane rows from audit (informational only — the t.me
//     politeness ceiling is the per-request pacer, not a daily envelope). When
//     no telegram audit rows exist yet the count is 0.
//
//   - quota.getRecentAudit(limit): last N audit rows with `telegram.%` actions
//     (operator-facing, allowlist-gated upstream). Empty until a telegram audit
//     verb is emitted.
//
// NO quotaCounters, NO userQuotaCap, NO slidingWindowQuota — there is no budget
// to fair-share (the whole point of Phase 9 vs IG: free source, no guardrails).
//
// requiresSingletonRuntime is false. Telegram's politeness budget lives in
// telegram_pacer and the lane worker takes that DB-backed token via the
// claimGate before claiming a row, so multi-replica workers don't burn attempts
// when no slot is available.

import { sql, desc, like } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";

/**
 * Synthetic daily usage. SUMs metadata.entries_processed across all
 * `telegram.queue_drained` audit rows in the last 24 hours (the lane worker may
 * emit this verb; until it does, the SUM is 0). There is NO daily cap on a free
 * source, so dailyLimit=0, pctOfDaily=0, throttleState="ok" — the value is a
 * dashboard "how busy was the Telegram lane today" signal only, never a gate.
 *
 * `_date` is honored for symmetry with the YouTube/Reddit getDailyStats(date)
 * contract — callers pass `new Date()` and we treat it as "now".
 *
 * Cross-tenant aggregation by design: /admin/quota is operator-facing
 * (allowlist-gated upstream).
 */
async function getDailyStats(_date: Date): Promise<ObservabilityDailyStats> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'entries_processed')::int), 0) AS units_used
    FROM audit_log
    WHERE action = 'telegram.queue_drained'
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  const unitsUsed = Number(
    (result as unknown as { rows: Array<{ units_used: number | string }> }).rows[0]?.units_used ??
      0,
  );
  // Free source — no daily cap. dailyLimit=0 means pctOfDaily=0, never throttled.
  return { unitsUsed, dailyLimit: 0, pctOfDaily: 0, throttleState: "ok" };
}

/** Last N audit rows with action LIKE 'telegram.%'. Operator-facing view; empty
 *  until a telegram audit verb is emitted. */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors reddit/observability.ts getRecentAudit.
  const rows = await db
    .select({
      action: auditLog.action,
      occurredAt: auditLog.createdAt,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(like(auditLog.action, "telegram.%"))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    action: r.action,
    occurredAt: r.occurredAt,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * telegramObservability — composed into telegramAdapter via the barrel
 * (index.ts). isOperatorConfigured is the CONSTANT `true`: Telegram needs no
 * secret/key/env to function, so it is always available (the structural
 * contrast with Reddit/IG that gate on a config value).
 */
export const telegramObservability: AdapterObservability = {
  auth: {
    kind: "scrape",
    requiresUserSetup: false,
    // Always configured — free public scrape, no secret to set.
    isOperatorConfigured: true,
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // No quotaCounters / userQuotaCap / slidingWindowQuota — Telegram is free,
  // there is no budget to fair-share (Phase 9's whole point vs IG).
  // FALSE — every t.me HTTP path is gated by telegram_pacer; the lane worker
  // runs claimGate before status='processing' / attempts+1, so replicas that
  // miss the DB token leave queue rows untouched.
  requiresSingletonRuntime: false,
};

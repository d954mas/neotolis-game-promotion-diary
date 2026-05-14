// Reddit adapter observability — DV-RDT-7 public-`.json` model.
//
// Three reads expose Reddit-side state to the cross-source /admin/quota
// dashboard:
//
//   1. getDailyStats(date) — synthetic daily aggregate. Reddit's quota is
//      per-MINUTE (10 req/min hard ceiling; 8 req/min effective via the
//      worker tick). YouTube's getDailyStats returns a daily Pacific
//      envelope; we report a parallel "8 req/min × 60 × 24" = 11520
//      theoretical ceiling and compute used from
//      audit_log.action='reddit.queue_drained' aggregation in the last 24
//      hours. The pctOfDaily fraction here is informational only —
//      Reddit's per-minute drain pacing is the load-bearing rate-limit
//      gate, not a daily envelope.
//
//   2. getRecentAudit(limit) — last N audit rows with `reddit.*` actions.
//      Aggregates across tenants by design (operator-facing dashboard,
//      gated by ADMIN_EMAIL_ALLOWLIST upstream).
//
//   3. getRecentLoad(seconds) — service-load gauge for the Reddit tab's
//      "N / 6 user slots available this minute" line (D-RDT-QUOTA-UI).
//      6 = per-minute user-slot capacity from REDDIT_SLOT_MAPPING (3
//      user_source + 3 user_post slots out of 8 ticks/min). Plan 08's
//      Reddit tab SSR loader reads this directly (not on the standard
//      AdapterObservability contract; exposed as a Reddit-only export).
//
// AUTH SHAPE: public-json-no-auth. isOperatorConfigured = true iff
// env.REDDIT_USER_AGENT is non-empty (the only Reddit-side env var).
// requiresUserSetup is false (no per-user secrets under DV-RDT-7).
//
// userQuotaCap is the two-axis sliding-window cap declared in plan 06's
// REDDIT_USER_CAP constant; importing from quota.ts keeps the cap
// DECLARATION and the cap COUNTER co-located (single source of truth).
//
// usesInProcessRateLimiter is false — Reddit's rate-limit budget lives
// on reddit_refresh_queue (SQL-backed; multi-replica safe via FOR UPDATE
// SKIP LOCKED). The 8-tick setInterval is single-process by D-RDT-WORKER
// but the queue itself doesn't carry in-process state.

import { sql, desc, like } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";
import { REDDIT_USER_CAP } from "./quota.js";

/** Synthetic daily ceiling: 8 req/min effective × 60 min × 24 h. */
const REDDIT_THEORETICAL_DAILY_CEILING = 8 * 60 * 24;

/** Per-minute user-slot capacity from REDDIT_SLOT_MAPPING (3 user_source
 *  + 3 user_post out of 8 ticks/min). Drives the D-RDT-QUOTA-UI
 *  "Service load: N / 6 user slots available this minute" line. */
export const REDDIT_USER_SLOTS_PER_MINUTE = 6 as const;

/**
 * Daily usage aggregate. Sums metadata.entries_processed across all
 * `reddit.queue_drained` audit rows in the last 24 hours.
 *
 * `_date` is honored for the symmetry with YouTube's getDailyStats(date)
 * — callers usually pass `new Date()` and we treat it as "now". A future
 * dashboard-history view could pass a backfilled date; for that case
 * we'd need a window_start/window_end pair. Keeping it as a single point
 * here matches the YouTube semantics.
 *
 * Cross-tenant aggregation by design: /admin/quota is operator-facing
 * (allowlist-gated upstream — see admin-quota-read.ts header). The
 * `reddit.queue_drained` verb is system-emitted under the operator's
 * resolved user_id (worker-tick.ts emitQueueDrainedAudit), so the SUM
 * over the verb yields the operator's pool view, not a tenant view.
 */
async function getDailyStats(_date: Date): Promise<ObservabilityDailyStats> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors admin-quota-read.ts.
  const result = await db.execute(sql`
    SELECT COALESCE(SUM((metadata->>'entries_processed')::int), 0) AS units_used
    FROM audit_log
    WHERE action = 'reddit.queue_drained'
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  const unitsUsed = Number(
    (result as unknown as { rows: Array<{ units_used: number | string }> }).rows[0]?.units_used ??
      0,
  );
  const dailyLimit = REDDIT_THEORETICAL_DAILY_CEILING;
  const pctOfDaily = dailyLimit > 0 ? unitsUsed / dailyLimit : 0;
  // 95% / 80% thresholds mirror the YouTube model semantically — Reddit's
  // actual rate-limit lives in the per-minute tick pacing; these are
  // dashboard signals only ("operator's pool is busy today").
  const throttleState: "ok" | "eighty" | "ninetyfive" =
    pctOfDaily >= 0.95 ? "ninetyfive" : pctOfDaily >= 0.8 ? "eighty" : "ok";
  return { unitsUsed, dailyLimit, pctOfDaily, throttleState };
}

/** Last N audit rows with action LIKE 'reddit.%'. Same shape as
 *  YouTube's getRecentAudit — operator-facing view of the four Reddit
 *  audit verbs (queue_drained, deletion_propagated, cap_exhausted,
 *  adapter_degraded). */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors admin-quota-read.ts.
  const rows = await db
    .select({
      action: auditLog.action,
      occurredAt: auditLog.createdAt,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(like(auditLog.action, "reddit.%"))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    action: r.action,
    occurredAt: r.occurredAt,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Service-load gauge for the Reddit tab — D-RDT-QUOTA-UI:
 * "Service load: N / 6 user slots available this minute".
 *
 * Counts entries in reddit_refresh_queue with status='done' on the two
 * user-driven queues (user_source + user_post) in the last `seconds`
 * window. Capacity is the per-minute user-slot count from
 * REDDIT_SLOT_MAPPING (8-tick mapping yields 3 user_source + 3 user_post
 * = 6 user-bound slots per minute).
 *
 * Plan 08 /admin/quota SSR loader calls getRecentLoad(60) and passes
 * {used, capacity} to QuotaStatusBanner's Reddit tab. Not on the
 * AdapterObservability standard contract — exposed directly because
 * Reddit's queue-table semantics don't map cleanly to YouTube's
 * RateLimiterMemory reservoir surface.
 */
export async function getRecentLoad(
  seconds = 60,
): Promise<{ used: number; capacity: typeof REDDIT_USER_SLOTS_PER_MINUTE }> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- queue table is operator-pool counter; cross-tenant aggregation by design for the service-load gauge.
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS used
    FROM reddit_refresh_queue
    WHERE status = 'done'
      AND queue_name IN ('user_source', 'user_post')
      AND last_attempt_at >= NOW() - make_interval(secs => ${seconds})
  `);
  const used = Number(
    (result as unknown as { rows: Array<{ used: number | string }> }).rows[0]?.used ?? 0,
  );
  return { used, capacity: REDDIT_USER_SLOTS_PER_MINUTE };
}

/**
 * redditObservability — surface composed into redditAdapter via the
 * barrel (index.ts). isOperatorConfigured is computed at module load
 * time: env.REDDIT_USER_AGENT is parsed once via $lib/server/config/env.ts
 * and doesn't change mid-process (operator restart required to flip,
 * mirroring YouTube's SERVICE_YOUTUBE_API_KEYS pattern).
 */
export const redditObservability: AdapterObservability = {
  auth: {
    kind: "public-json-no-auth",
    requiresUserSetup: false,
    isOperatorConfigured: env.REDDIT_USER_AGENT !== "",
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // Two-axis sliding-window cap declared in plan 06's REDDIT_USER_CAP.
  // Importing from quota.ts keeps the cap DECLARATION (here) and the cap
  // COUNTER (checkRedditUserCap) co-located: single source of truth.
  userQuotaCap: {
    sourceActionsPerWindow: REDDIT_USER_CAP.sourceActionsPerWindow,
    postRefreshesPerWindow: REDDIT_USER_CAP.postRefreshesPerWindow,
    windowMinutes: REDDIT_USER_CAP.windowMinutes,
  },
  // Reddit's rate-limit lives on the SQL-backed reddit_refresh_queue
  // (FOR UPDATE SKIP LOCKED is multi-replica safe). The 8-tick
  // setInterval is single-process by D-RDT-WORKER, but the QUEUE state
  // is persistent — adapter declares false so multi-replica scaling
  // doesn't trip worker bootstrap's in-process-rate-limiter guard.
  usesInProcessRateLimiter: false,
};

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
  // Cross-tenant audit aggregation by design — /admin/quota observability
  // is allowlist-gated upstream (see admin-quota-read.ts). The raw-SQL
  // path doesn't trigger the tenant-scope ESLint rule, but documenting
  // the rationale here for the next reader.
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

/** Valid queue lanes — mirrors the CHECK constraint on
 *  reddit_refresh_queue.queue_name. */
export const REDDIT_QUEUE_NAMES = [
  "service_source",
  "service_post",
  "user_source",
  "user_post",
] as const;
export type RedditQueueName = (typeof REDDIT_QUEUE_NAMES)[number];

/** Valid handler types — mirrors the CHECK constraint on
 *  reddit_refresh_queue.type. */
export const REDDIT_QUEUE_TYPES = ["sub_poll", "author_poll", "post_single", "post_batch"] as const;
export type RedditQueueType = (typeof REDDIT_QUEUE_TYPES)[number];

/** One row in the live queue-depth snapshot rendered on the /admin
 *  Reddit Ops panel. Aggregates one queue_name lane across all
 *  in-flight + alarm states. */
export interface RedditQueueDepthRow {
  queueName: RedditQueueName;
  pending: number;
  processing: number;
  deadLetter: number;
  /** Age of the oldest `pending` row in this lane, in seconds. `null`
   *  if no pending rows. Drives "Самая старая" column. */
  oldestPendingAgeSeconds: number | null;
}

/**
 * Live queue-depth snapshot. Returns one row per queue_name lane,
 * counting `pending` + `processing` + `dead_letter` rows. `done` is
 * excluded — done rows are audit history, not queue depth.
 *
 * Operator dashboard signal:
 *   - pending     — "how many tasks are waiting right now"
 *   - processing  — usually 0-1 (FOR UPDATE SKIP LOCKED holds the row
 *                   for milliseconds while the handler runs)
 *   - dead_letter — alarm — N retry attempts exhausted, manual review
 *                   needed
 *   - oldestPendingAgeSeconds — backpressure indicator: a queue with 50
 *                   pending and oldest=10s is healthy; 50 pending and
 *                   oldest=10min means the worker can't drain fast
 *                   enough.
 *
 * Cross-tenant aggregation by design — /admin is allowlist-gated.
 */
export async function getQueueDepth(): Promise<RedditQueueDepthRow[]> {
  const result = await db.execute(sql`
    SELECT
      queue_name,
      status,
      COUNT(*)::int AS count,
      EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at)))::int AS oldest_age_seconds
    FROM reddit_refresh_queue
    WHERE status IN ('pending', 'processing', 'dead_letter')
    GROUP BY queue_name, status
  `);
  const rows = (
    result as unknown as {
      rows: Array<{
        queue_name: string;
        status: string;
        count: number | string;
        oldest_age_seconds: number | string | null;
      }>;
    }
  ).rows;

  // Start with zero-filled lanes so the operator sees all 4 rows even
  // when an entire lane is idle (the absence of a lane in the result
  // set is itself a signal — "nothing has been enqueued today").
  const byLane = new Map<RedditQueueName, RedditQueueDepthRow>();
  for (const name of REDDIT_QUEUE_NAMES) {
    byLane.set(name, {
      queueName: name,
      pending: 0,
      processing: 0,
      deadLetter: 0,
      oldestPendingAgeSeconds: null,
    });
  }
  for (const r of rows) {
    const lane = byLane.get(r.queue_name as RedditQueueName);
    if (!lane) continue;
    const count = Number(r.count);
    if (r.status === "pending") {
      lane.pending = count;
      lane.oldestPendingAgeSeconds =
        r.oldest_age_seconds === null ? null : Number(r.oldest_age_seconds);
    } else if (r.status === "processing") {
      lane.processing = count;
    } else if (r.status === "dead_letter") {
      lane.deadLetter = count;
    }
  }
  return Array.from(byLane.values());
}

/**
 * Daily processed-entries breakdown. Aggregates rows in
 * reddit_refresh_queue with status='done' and last_attempt_at within
 * the last 24 hours, grouped by handler type. The per-type counts are
 * a close proxy for HTTP requests issued to Reddit (each handler
 * typically performs 1 fetch per drained entry).
 *
 * Operator dashboard signal:
 *   - total                         — "how many entries we processed today"
 *   - byType.sub_poll               — sub listing walks
 *   - byType.author_poll            — author submitted-page walks
 *   - byType.post_single            — paste-driven single-post fetches
 *   - byType.post_batch             — service post-refresh batches
 *   - adapterDegradedSince          — last `reddit.adapter_degraded` audit
 *                                     timestamp within the 24h window
 *                                     (403-burst warning), or null
 */
export interface RedditDailyByType {
  total: number;
  byType: Record<RedditQueueType, number>;
  capExhaustedCount: number;
  adapterDegradedSince: Date | null;
}

export async function getDailyByType(): Promise<RedditDailyByType> {
  const typeResult = await db.execute(sql`
    SELECT type, COUNT(*)::int AS count
    FROM reddit_refresh_queue
    WHERE status = 'done'
      AND last_attempt_at >= NOW() - INTERVAL '24 hours'
    GROUP BY type
  `);
  const typeRows = (
    typeResult as unknown as {
      rows: Array<{ type: string; count: number | string }>;
    }
  ).rows;
  const byType: Record<RedditQueueType, number> = {
    sub_poll: 0,
    author_poll: 0,
    post_single: 0,
    post_batch: 0,
  };
  let total = 0;
  for (const r of typeRows) {
    const count = Number(r.count);
    if ((REDDIT_QUEUE_TYPES as readonly string[]).includes(r.type)) {
      byType[r.type as RedditQueueType] = count;
      total += count;
    }
  }

  // Cap-exhaustion + adapter-degraded alarms within the same window.
  // Single round-trip — two COUNT/MAX in one query keeps observability
  // SSR loaders cheap.
  const alarmsResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE action = 'reddit.cap_exhausted')::int AS cap_exhausted_count,
      MAX(created_at) FILTER (WHERE action = 'reddit.adapter_degraded') AS adapter_degraded_since
    FROM audit_log
    WHERE created_at >= NOW() - INTERVAL '24 hours'
      AND action IN ('reddit.cap_exhausted', 'reddit.adapter_degraded')
  `);
  const alarmRow = (
    alarmsResult as unknown as {
      rows: Array<{
        cap_exhausted_count: number | string | null;
        adapter_degraded_since: Date | string | null;
      }>;
    }
  ).rows[0];
  const capExhaustedCount = Number(alarmRow?.cap_exhausted_count ?? 0);
  const adapterDegradedSince = alarmRow?.adapter_degraded_since
    ? new Date(alarmRow.adapter_degraded_since)
    : null;

  return { total, byType, capExhaustedCount, adapterDegradedSince };
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
  // Queue table is operator-pool counter; cross-tenant aggregation by
  // design for the service-load gauge. Raw-SQL path bypasses the
  // tenant-scope rule, but documenting the rationale here.
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

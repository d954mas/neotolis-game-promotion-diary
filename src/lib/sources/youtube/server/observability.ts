// YouTube observability.
//
// Implements the per-adapter observability surface used by /admin/quota
// and (future) /sources/[id] connection-status badges.
//
// Two reads expose today's operator-side state to the cross-source admin
// dashboard:
//
//   - getDailyStats(date) — sums today's youtube_service_quota_usage rows
//     into a single ObservabilityDailyStats record (unitsUsed / dailyLimit
//     / pctOfDaily / throttleState / per-key breakdown). Drives the
//     /admin/quota throttle banner + per-key list. Date arg is honored
//     (callers usually pass `new Date()`); callers asking for an earlier
//     date get that day's snapshot.
//
//   - getRecentAudit(limit) — returns the last N audit_log rows with
//     youtube-specific verbs. Aggregates across tenants by design — the
//     admin dashboard is operator-facing and the security gate is the
//     env allowlist (see admin-quota-read.ts header). Today
//     `quota.service_throttled` and `source.refresh_content_requested`
//     are youtube-specific; future YouTube verbs append to
//     YOUTUBE_AUDIT_ACTIONS.
//
// AUTH SHAPE: operator-static-key — env.SERVICE_YOUTUBE_API_KEYS
// holds plaintext API keys; isOperatorConfigured is true iff at least one
// non-empty key exists. requiresUserSetup is false (a future per-user
// creds option would flip this conditionally).

import { eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeServiceQuotaUsage } from "$lib/server/db/schema/index.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";

export const YOUTUBE_QUEUE_NAMES = ["user_video", "service_video"] as const;
export type YoutubeQueueName = (typeof YOUTUBE_QUEUE_NAMES)[number];
export const YOUTUBE_QUEUE_TYPES = ["video_stats"] as const;
export type YoutubeQueueType = (typeof YOUTUBE_QUEUE_TYPES)[number];

export interface YoutubeQueueDepthRow {
  queueName: YoutubeQueueName;
  pending: number;
  processing: number;
  deadLetter: number;
  oldestPendingAgeSeconds: number | null;
}

export interface YoutubeDailyByType {
  total: number;
  byType: Record<YoutubeQueueType, number>;
  /** All-time count of done rows on user_video lane — exposes the
   *  "all the user-initiated refreshes we've ever processed" total
   *  the admin asked for alongside the 24h breakdown. */
  lifetimeUserVideos: number;
}

/**
 * Live per-lane queue depth (pending / processing / dead_letter).
 * `done` rows are excluded — they're history, not depth.
 *
 * Reads the shared `adapter_refresh_queue` filtered by
 * `adapter_kind='youtube_channel'`. Mirrors getQueueDepth from the
 * Reddit observability surface so /admin can render an analogous panel.
 */
export async function getYoutubeQueueDepth(): Promise<YoutubeQueueDepthRow[]> {
  const result = await db.execute(sql`
    SELECT
      queue_name,
      status,
      COUNT(*)::int AS count,
      EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at)))::int AS oldest_age_seconds
    FROM adapter_refresh_queue
    WHERE adapter_kind = 'youtube_channel'
      AND status IN ('pending', 'processing', 'dead_letter')
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

  const byLane = new Map<YoutubeQueueName, YoutubeQueueDepthRow>();
  for (const name of YOUTUBE_QUEUE_NAMES) {
    byLane.set(name, {
      queueName: name,
      pending: 0,
      processing: 0,
      deadLetter: 0,
      oldestPendingAgeSeconds: null,
    });
  }
  for (const r of rows) {
    const lane = byLane.get(r.queue_name as YoutubeQueueName);
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
 * 24h done-row breakdown by handler type + lifetime user_video total.
 * Per-type count is a close proxy for YouTube `videos.list` calls
 * (each row drained = one batched API request).
 */
export async function getYoutubeDailyByType(): Promise<YoutubeDailyByType> {
  const typeResult = await db.execute(sql`
    SELECT type, COUNT(*)::int AS count
    FROM adapter_refresh_queue
    WHERE adapter_kind = 'youtube_channel'
      AND status = 'done'
      AND last_attempt_at >= NOW() - INTERVAL '24 hours'
    GROUP BY type
  `);
  const typeRows = (
    typeResult as unknown as {
      rows: Array<{ type: string; count: number | string }>;
    }
  ).rows;
  const byType: Record<YoutubeQueueType, number> = { video_stats: 0 };
  let total = 0;
  for (const r of typeRows) {
    const count = Number(r.count);
    if ((YOUTUBE_QUEUE_TYPES as readonly string[]).includes(r.type)) {
      byType[r.type as YoutubeQueueType] = count;
      total += count;
    }
  }

  const lifetimeResult = await db.execute(sql`
    SELECT COUNT(*)::bigint AS count
    FROM adapter_refresh_queue
    WHERE adapter_kind = 'youtube_channel'
      AND queue_name = 'user_video'
      AND status = 'done'
  `);
  const lifetimeUserVideos = Number(
    (lifetimeResult as unknown as { rows: Array<{ count: string | number }> }).rows[0]?.count ?? 0,
  );

  return { total, byType, lifetimeUserVideos };
}
import type {
  AdapterObservability,
  ObservabilityDailyStats,
  ObservabilityAuditEntry,
} from "$lib/sources/adapter.js";
import { THROTTLE_EIGHTY_THRESHOLD, THROTTLE_NINETYFIVE_THRESHOLD, todayPacific } from "./quota.js";

// YouTube Data API v3 default daily quota per key. The threshold
// constants in quota.ts (THROTTLE_EIGHTY_THRESHOLD = 8000,
// THROTTLE_NINETYFIVE_THRESHOLD = 9500) are derived from this same 10_000
// number; we re-derive pctOfDaily here so the dashboard's throttle banner
// agrees with the scheduler's gate.
const DAILY_LIMIT_PER_KEY = 10_000;

/**
 * Sum today's per-key usage rows and project to ObservabilityDailyStats.
 *
 * `pctOfDaily` is a fraction (0..1) — adapter-contract shape. The
 * /admin/quota route's existing wire format (pctOfDaily as 0-100 percent
 * + status string `'ok'|'80_throttle'|'95_throttle'`) is preserved by
 * the consumer (admin-quota-read.ts) translating from this richer shape
 * — the route response is unchanged.
 *
 * youtube_service_quota_usage is OPERATOR-SIDE (no user_id column);
 * eslint-disable on the SELECT.where call is intentionally absent because
 * the table is in the tenant-scope rule's allowlist (with the
 * "operator-side counter, no tenant scope" comment that the rule walks
 * for).
 */
async function getDailyStats(date: Date): Promise<ObservabilityDailyStats> {
  const datePT = todayPacific(date);
  // Sum across pool_kind per api_key_id. Pool split is an internal
  // artifact; per-key throttleState compares the total against operator's
  // per-key 10000 envelope. /admin/quota's per-key view is also total
  // (cron + user). If a pool-aware breakdown is needed in the UI later,
  // extend ObservabilityDailyStats.keys[] to include per-pool fields.
  const rows = await db
    .select({
      apiKeyId: youtubeServiceQuotaUsage.apiKeyId,
      estimatedUnits: sql<number>`SUM(${youtubeServiceQuotaUsage.estimatedUnits})::int`,
    })
    .from(youtubeServiceQuotaUsage)
    .where(eq(youtubeServiceQuotaUsage.datePacific, datePT))
    .groupBy(youtubeServiceQuotaUsage.apiKeyId);

  // Daily limit envelopes the operator's full key set. Empty env ⇒ at
  // least 1 in the denominator so pctOfDaily doesn't divide by zero (the
  // dashboard renders "no keys configured" copy upstream when isOperatorConfigured=false,
  // but this function never throws).
  const numKeys = env.SERVICE_YOUTUBE_API_KEYS.length || 1;
  const dailyLimit = DAILY_LIMIT_PER_KEY * numKeys;
  const unitsUsed = rows.reduce((sum, r) => sum + (r.estimatedUnits ?? 0), 0);
  const pctOfDaily = dailyLimit > 0 ? unitsUsed / dailyLimit : 0;

  // throttleState matches the WORST-key state, not the aggregate state —
  // mirrors getThrottleState in quota.ts. Any single key at 95% pauses
  // everything-but-refresh-now; any single key at 80% pauses Cold + auto-import.
  let throttleState: "ok" | "eighty" | "ninetyfive" = "ok";
  for (const r of rows) {
    const u = r.estimatedUnits ?? 0;
    if (u >= THROTTLE_NINETYFIVE_THRESHOLD) {
      throttleState = "ninetyfive";
      break;
    }
    if (u >= THROTTLE_EIGHTY_THRESHOLD) {
      throttleState = "eighty";
    }
  }

  return {
    unitsUsed,
    dailyLimit,
    pctOfDaily,
    throttleState,
    keys: rows.map((r) => {
      const u = r.estimatedUnits ?? 0;
      const keyState: "ok" | "eighty" | "ninetyfive" =
        u >= THROTTLE_NINETYFIVE_THRESHOLD
          ? "ninetyfive"
          : u >= THROTTLE_EIGHTY_THRESHOLD
            ? "eighty"
            : "ok";
      return { apiKeyId: r.apiKeyId, unitsUsed: u, throttleState: keyState };
    }),
  };
}

/**
 * YouTube-specific audit_action verbs surfaced on /admin/quota's youtube
 * tab. Today only quota.service_throttled is youtube-specific (purge.completed,
 * auto_import.deferred, poll.failed are cross-source — admin-quota-read.ts
 * still surfaces those itself for backward compatibility).
 *
 * Future YouTube-specific verbs (e.g. 'youtube.channel_context_backfilled',
 * 'youtube.rehab_succeeded') append here. Keep the array sorted
 * lexicographically for diff-friendliness.
 */
const YOUTUBE_AUDIT_ACTIONS = ["quota.service_throttled"] as const;

/**
 * Returns the most recent N audit_log rows with youtube-specific actions,
 * ordered by createdAt DESC.
 *
 * Cross-tenant aggregation by design: /admin/quota is the operator's
 * signal pane; user_id scoping is meaningless for system-emitted verbs
 * (the operator's own user_id IS the user_id under which throttle audits
 * are written — see quota.ts.markThrottleTransition).
 *
 * The eslint-disable below is the same shape as admin-quota-read.ts's
 * existing audit_log SELECT — same justification (allowlist-gated upstream;
 * cross-tenant aggregation is the intended operator view).
 */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors the same justification on admin-quota-read.ts's audit query.
  const rows = await db
    .select({
      action: auditLog.action,
      occurredAt: auditLog.createdAt,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(inArray(auditLog.action, [...YOUTUBE_AUDIT_ACTIONS]))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    action: r.action,
    occurredAt: r.occurredAt,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * youtubeObservability — surface consumed by ./adapter.ts (which spreads
 * it into the SourceAdapter contract) and (transitively) by
 * /admin/quota's loadAdminQuotaPage via getAdapter("youtube_channel").observability.
 *
 * `isOperatorConfigured` is computed at module load time. env is parsed
 * once at boot via $lib/server/config/env.ts; recomputing on every read
 * would be either pointless (env doesn't change mid-process) or wrong
 * (post-scrubKekFromEnv, the raw env vars are gone — but
 * env.SERVICE_YOUTUBE_API_KEYS is the parsed string[], unaffected by the
 * scrub).
 */
export const youtubeObservability: AdapterObservability = {
  auth: {
    kind: "operator-static-key",
    requiresUserSetup: false,
    isOperatorConfigured: env.SERVICE_YOUTUBE_API_KEYS.length > 0,
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // Per-user fair-share cap. 100 API requests/day = ~5000 events worth
  // (YouTube playlistItems.list returns 50 items/page = 1 unit). 100 = 1%
  // of operator's 10k daily quota; supports ~20 active users
  // simultaneously exhausting their cap before the operator pool drains.
  // eventsPerDay is not declared — YouTube has fixed 50:1 ratio, a
  // secondary cap is redundant. Other source kinds may declare both axes
  // (variable events-per-request).
  //
  // Cap counts user-initiated actions: initial onboarding + incremental
  // refresh + historical refresh + stats_refresh. Excluded only:
  // auto_passive cron (uses cron pool, not user pool). Onboarding-burn
  // counts because the user explicitly opted into a backfill window.
  userQuotaCap: {
    requestsPerDay: 100,
  },
  // Quota reservation lives in youtube_service_quota_usage under row locks,
  // so the adapter does not need a singleton runtime.
  requiresSingletonRuntime: false,
};

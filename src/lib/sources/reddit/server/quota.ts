// Reddit per-user two-axis cap (DV-RDT-7): 1 source-action / 5min +
// 25 post-refresh / 5min sliding window.
//
// Why a Reddit-specific module (and not in src/lib/server/services/quota.ts):
// Reddit's cap is a TWO-AXIS SLIDING-WINDOW model that doesn't fit
// YouTube's per-Pacific-day requestsPerDay/eventsPerDay shape. Source-
// actions are measured against audit_log (one COUNT query); post-
// refreshes are measured against reddit_refresh_queue (a different
// COUNT query). Both have a 5-minute rolling window keyed on UTC, not
// the Pacific calendar day. Co-locating both axes here keeps the
// counter and the Reddit-specific error-code naming together. The
// cross-source services/quota.ts orchestrator lazy-imports this module
// when adapter.observability.userQuotaCap declares the two-axis shape.
//
// Source-actions axis (D-RDT-CAP-SOURCE): COUNT(audit_log) WHERE
//   user_id=$user
//   AND action='source.refresh_content_requested'
//   AND metadata->>'platform' IN ('reddit_account','reddit_subreddit')
//   AND metadata->>'flow' != 'auto_passive'   -- cron flows excluded
//   AND created_at > NOW() - INTERVAL '5 minutes'
//
// Post-refreshes axis (D-RDT-CAP-POST): COUNT(reddit_refresh_queue)
//   WHERE user_id=$user
//     AND queue_name='user_post'              -- only user lane
//     AND enqueued_at > NOW() - INTERVAL '5 minutes'
//
// Cron exclusions (D-RDT-CAP-COUNTER):
//   - Audit rows with metadata.flow='auto_passive' (daily cron picks
//     burn the operator's cron reservoir, not the per-user cap).
//   - Queue rows with user_id IS NULL (service_source / service_post
//     lanes — operator-driven, not user-initiated).
//
// SOFT FAIRNESS CAP — same caveat as services/quota.ts:
//   The cap-check pattern (read counter -> compare -> enqueue) is not
//   atomic. Two concurrent requests from the same user at 0/1 can both
//   pass the gate before either's audit row settles. Result: brief
//   overshoot to 2/1 on the source-actions axis under contention.
//   Accepted: this is a fairness signal protecting shared operator
//   throughput, not a security-grade ceiling. A strict atomic check
//   would require pg_advisory_xact_lock(hashtext(userId)) on every
//   refresh-content / paste click — cost-prohibitive at indie scale.

import { and, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { redditRefreshQueue } from "$lib/sources/reddit/server/schema/index.js";
import { writeAudit } from "$lib/server/audit.js";

/** Two-axis sliding-window cap. Adapter declares the same shape via
 *  observability.userQuotaCap so cross-source code can read the cap
 *  values without hard-coding them. */
export const REDDIT_USER_CAP = {
  sourceActionsPerWindow: 1,
  postRefreshesPerWindow: 25,
  windowMinutes: 5,
} as const;

export type RedditCapAxis = "source-actions" | "post-refreshes";

export interface RedditCapResult {
  allowed: boolean;
  axis: RedditCapAxis;
  cap: number;
  used: number;
  window_minutes: number;
  /**
   * Seconds until the OLDEST counted row falls out of the rolling 5-min
   * window. For a fresh user with no rows it's the full window (300s).
   * For a user one row deep at +3min in, it's 120s. Clamped to ≥1 so
   * Retry-After / setTimeout never receive 0.
   */
  reset_in_seconds: number;
}

/**
 * Compute the cap state for `userId` on the given `axis`. dbCtx may be
 * a Drizzle db handle OR an inner tx; the count joins the caller's
 * transaction when one is active (callers in a service-tx pass `tx`).
 *
 * Per-axis SQL:
 *   - source-actions: audit_log COUNT + MIN(created_at) under the 5-min
 *     window for this user and the reddit_* platforms, excluding the
 *     cron-driven auto_passive flow.
 *   - post-refreshes: reddit_refresh_queue COUNT + MIN(enqueued_at)
 *     under the 5-min window for this user on the user_post lane.
 *
 * The single COUNT-and-MIN query lets us derive `reset_in_seconds`
 * without a second round-trip — caller surfaces it in the 429 response.
 */
export async function checkRedditUserCap(
  dbCtx: DbOrTx,
  userId: string,
  axis: RedditCapAxis,
): Promise<RedditCapResult> {
  const windowMs = REDDIT_USER_CAP.windowMinutes * 60 * 1000;
  const since = new Date(Date.now() - windowMs);

  if (axis === "source-actions") {
    const rows = await dbCtx
      .select({
        used: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${auditLog.createdAt})`,
      })
      .from(auditLog)
      .where(
        and(
          // tenant-scope: audit rows scoped to this user only.
          eq(auditLog.userId, userId),
          eq(auditLog.action, "source.refresh_content_requested"),
          sql`${auditLog.metadata}->>'platform' IN ('reddit_account','reddit_subreddit')`,
          // auto_passive rows are cron-driven and excluded. NULL flow
          // counts (defense-in-depth — a writer that forgot to set
          // flow=auto_passive but otherwise wrote a cron-shaped row
          // would still get counted; acceptable since "no flow set"
          // for a user-initiated row is the production norm).
          sql`(${auditLog.metadata}->>'flow' IS NULL OR ${auditLog.metadata}->>'flow' != 'auto_passive')`,
          gte(auditLog.createdAt, since),
        ),
      );
    const used = Number(rows[0]?.used ?? 0);
    const cap = REDDIT_USER_CAP.sourceActionsPerWindow;
    return {
      allowed: used < cap,
      axis,
      cap,
      used,
      window_minutes: REDDIT_USER_CAP.windowMinutes,
      reset_in_seconds: computeResetSeconds(rows[0]?.oldestAt ?? null, windowMs),
    };
  }

  // post-refreshes axis
  const rows = await dbCtx
    .select({
      used: sql<number>`count(*)::int`,
      oldestAt: sql<Date | null>`min(${redditRefreshQueue.enqueuedAt})`,
    })
    .from(redditRefreshQueue)
    .where(
      and(
        // user_id NOT NULL eliminates cron-lane rows by construction
        // (D-RDT-CAP-COUNTER). Combined with queue_name='user_post' the
        // filter narrows to user-initiated post refreshes only.
        eq(redditRefreshQueue.userId, userId),
        eq(redditRefreshQueue.queueName, "user_post"),
        gte(redditRefreshQueue.enqueuedAt, since),
      ),
    );
  const used = Number(rows[0]?.used ?? 0);
  const cap = REDDIT_USER_CAP.postRefreshesPerWindow;
  return {
    allowed: used < cap,
    axis,
    cap,
    used,
    window_minutes: REDDIT_USER_CAP.windowMinutes,
    reset_in_seconds: computeResetSeconds(rows[0]?.oldestAt ?? null, windowMs),
  };
}

/**
 * Reset-in-seconds = (windowMs - (now - oldestAt)) / 1000, clamped ≥1.
 * For a user with no rows the oldest is null and the full window
 * (300s) remains.
 */
function computeResetSeconds(oldestAt: Date | null, windowMs: number): number {
  if (oldestAt === null) return Math.floor(windowMs / 1000);
  const elapsed = Date.now() - new Date(oldestAt).getTime();
  const remaining = windowMs - elapsed;
  return Math.max(1, Math.ceil(remaining / 1000));
}

/**
 * Write `reddit.cap_exhausted` audit row when caller decides to 429.
 * Called from the cross-source quota orchestrator before throwing the
 * AppError. Audit metadata follows D-RDT-AUDIT-VERBS:
 *   { cap_type: 'source' | 'post', cap, used, window_minutes }
 *
 * Uses writeAudit (swallows errors): a failed audit must not break the
 * 429 response. The 429 itself is the user-facing signal; the audit
 * row is forensics-only.
 */
export async function writeRedditCapExhaustedAudit(args: {
  userId: string;
  ipAddress: string;
  axis: RedditCapAxis;
  cap: number;
  used: number;
}): Promise<void> {
  await writeAudit({
    userId: args.userId,
    ipAddress: args.ipAddress,
    action: "reddit.cap_exhausted",
    metadata: {
      cap_type: args.axis === "source-actions" ? "source" : "post",
      cap: args.cap,
      used: args.used,
      window_minutes: REDDIT_USER_CAP.windowMinutes,
    },
  });
}

/**
 * Maps cap axis to the structured 429 error code (D-RDT-CAP-EXCEED).
 * Cross-source services/quota.ts threads this through AppError.code so
 * the route layer surfaces:
 *   - reddit_source_quota_exhausted  (source-actions axis)
 *   - reddit_post_quota_exhausted    (post-refreshes axis)
 * Plan 08 ties these codes into the QuotaStatusBanner banner toast.
 */
export function redditCapErrorCode(axis: RedditCapAxis): string {
  return axis === "source-actions"
    ? "reddit_source_quota_exhausted"
    : "reddit_post_quota_exhausted";
}

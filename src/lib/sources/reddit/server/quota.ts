// Reddit per-user two-axis cap: 1 source-action / 5min + 25
// post-refresh / 5min sliding window.
//
// Both axes share ONE source of truth: `adapter_refresh_queue`. A user
// action that costs a Reddit unit enqueues a row on the appropriate
// lane (user_source or user_post); the cap query just COUNTs rows in
// the last 5 minutes on the lane it cares about.
//
//   source-actions axis:
//     SELECT count(*) FROM adapter_refresh_queue
//     WHERE user_id = $user
//       AND queue_name = 'user_source'
//       AND enqueued_at > NOW() - INTERVAL '5 minutes'
//
//   post-refreshes axis:
//     SELECT count(*) FROM adapter_refresh_queue
//     WHERE user_id = $user
//       AND queue_name = 'user_post'
//       AND enqueued_at > NOW() - INTERVAL '5 minutes'
//
// Cron rows have `user_id IS NULL` (they live on service_source /
// service_post lanes), so the user-lane filter excludes them by
// construction.
//
// Why this module (and not src/lib/server/services/quota.ts): Reddit's
// shape doesn't fit YouTube's per-Pacific-day requestsPerDay model —
// it's a 5-minute UTC sliding window with TWO independent axes. The
// cross-source orchestrator lazy-imports this module only when an
// adapter declares the two-axis shape via observability.userQuotaCap.
//
// SOFT FAIRNESS CAP — same caveat as services/quota.ts: cap-check +
// enqueue is not atomic. Two concurrent requests at 0/1 can both pass
// the gate before either row settles, briefly overshooting to 2/1.
// Accepted: this is a fairness signal, not a security-grade ceiling.
// An atomic check would need pg_advisory_xact_lock(hashtext(userId))
// on every click — cost-prohibitive at indie scale.

import { and, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { writeAudit } from "$lib/server/audit.js";

/** Two-axis sliding-window cap. Adapter declares the same shape via
 *  observability.userQuotaCap so cross-source code can read the cap
 *  values without hard-coding them.
 *
 *  v0.1 calibration (15-min window, shared across both axes):
 *    - sourceActionsPerWindow=5 — covers indie onboarding (paste 2-3
 *      subreddits + 1-2 user profiles in one sitting) without forcing
 *      delays between adds.
 *    - postRefreshesPerWindow=30 — typical indie users hit refresh on
 *      a handful of recent posts; 2/min sustained throughput is
 *      plenty. Lower than the original 25/5min ratio on purpose:
 *      v0.1 doesn't have enough multi-tenant signal to justify
 *      letting one user burn 75 Reddit slots in 15 minutes. */
export const REDDIT_USER_CAP = {
  sourceActionsPerWindow: 5,
  postRefreshesPerWindow: 30,
  windowMinutes: 15,
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
 * transaction when one is active.
 *
 * Both axes COUNT + MIN(enqueued_at) over adapter_refresh_queue under a
 * 5-minute UTC rolling window. axis only changes which queue_name
 * lane the WHERE filters to:
 *   - source-actions  → user_source
 *   - post-refreshes  → user_post
 *
 * Returning oldestAt lets the caller derive `reset_in_seconds` without
 * a second round-trip — the cap clears when the oldest counted row
 * falls out of the window.
 */
export async function checkRedditUserCap(
  dbCtx: DbOrTx,
  userId: string,
  axis: RedditCapAxis,
): Promise<RedditCapResult> {
  const windowMs = REDDIT_USER_CAP.windowMinutes * 60 * 1000;
  const since = new Date(Date.now() - windowMs);

  if (axis === "source-actions") {
    // Queue-based counter (mirrors the post-refreshes axis below). The
    // earlier audit-log-based counter read `source.refresh_content_requested`
    // only — which never fires on createSource (writes verb=source.added)
    // — so register actions slipped through the cap entirely. Migrating
    // both axes to adapter_refresh_queue gives a uniform source of truth:
    // any user-initiated Reddit operation enqueues a row on the user_source
    // lane (createSource → onSourceCreated → backfillSource → user_source
    // INSERT; refresh-content → backfillSource → user_source INSERT).
    // user_id NOT NULL + queue_name='user_source' filters out cron-lane
    // rows by construction.
    const rows = await dbCtx
      .select({
        used: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${adapterRefreshQueue.enqueuedAt})`,
      })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "reddit_account"),
          eq(adapterRefreshQueue.userId, userId),
          eq(adapterRefreshQueue.queueName, "user_source"),
          gte(adapterRefreshQueue.enqueuedAt, since),
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
      oldestAt: sql<Date | null>`min(${adapterRefreshQueue.enqueuedAt})`,
    })
    .from(adapterRefreshQueue)
    .where(
      and(
        // user_id NOT NULL eliminates cron-lane rows by construction
        //. Combined with queue_name='user_post' the
        // filter narrows to user-initiated post refreshes only.
        eq(adapterRefreshQueue.adapterKind, "reddit_account"),
        eq(adapterRefreshQueue.userId, userId),
        eq(adapterRefreshQueue.queueName, "user_post"),
        gte(adapterRefreshQueue.enqueuedAt, since),
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
 * Reset-in-seconds = (windowMs - (now - oldestAt)) / 1000, clamped to
 * the closed range [1, windowMs/1000]. For a user with no rows the
 * oldest is null and the full window (300s) remains.
 *
 * The upper clamp is load-bearing: when oldestAt comes from a Postgres
 * NOW()-stamped row but `Date.now()` is read from the Node process,
 * tiny clock skew between the two can make `elapsed` negative, which
 * pushes `remaining` above `windowMs` and the reported reset above the
 * window ceiling. Callers (UI banner, Retry-After header) document the
 * cap window as ≤ windowMs; surfacing > windowMs would surprise both.
 */
function computeResetSeconds(oldestAt: Date | null, windowMs: number): number {
  const windowSeconds = Math.floor(windowMs / 1000);
  if (oldestAt === null) return windowSeconds;
  const elapsed = Date.now() - new Date(oldestAt).getTime();
  const remaining = windowMs - elapsed;
  return Math.min(windowSeconds, Math.max(1, Math.ceil(remaining / 1000)));
}

/**
 * Write `reddit.cap_exhausted` audit row when caller decides to 429.
 * Called from the cross-source quota orchestrator before throwing the
 * AppError. Audit metadata shape:
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
 * Maps cap axis to the structured 429 error code.
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

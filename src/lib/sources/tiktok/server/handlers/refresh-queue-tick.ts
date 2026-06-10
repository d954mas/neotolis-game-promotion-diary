// TikTok per-post stats refresh — SQL lane worker (clone of instagram/server/
// handlers/refresh-queue-tick.ts).
//
// Two slots over adapter_refresh_queue:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED
//                      (the user owns the event); fetch charges the USER pool.
//   - "service_post" — CRON warm auto-refresh. Payload {post_id}, user_id NULL.
//                      PUBLIC-DATA, NO event lookup; fetch charges the OPERATOR
//                      (cron) pool.
//
// This worker claims up to N rows of ONE slot per tick (N =
// env.SOCIAL_REFRESH_LANE_CONCURRENCY; batchScope "global") and refreshes them
// CONCURRENTLY: TikTok's single-video endpoint can't batch (1 request = 1 video),
// so scale comes from concurrency.
//
// Each post is independent → dispatch uses Promise.allSettled, writes a per-post
// snapshot (ok or non-ok), and NEVER throws — the lane worker then marks every
// claimed row `done`. A transient failure lands a non-ok snapshot (which stamps
// tiktok_posts.last_polled_at, so the RefreshNowButton stop-loop settles) and is
// recovered by the user re-clicking or the next scheduled source poll.
//
// The credit reserve happens INSIDE provider.fetchPostByUrl (origin "user"/"cron"),
// so claimGate is a throttle gate ONLY (defer at 95%), never a second reserve.

import { and, eq, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterBatchLaneWorkerTickResult,
  type AdapterLaneClaimGateContext,
  type AdapterLaneClaimGateResult,
  type AdapterLaneWorkerRow,
} from "$lib/server/services/adapter-lane-worker.js";
import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError, categoryToSnapshotStatus } from "$lib/sources/errors.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";

export const TIKTOK_REFRESH_SLOTS = ["user_post", "service_post"] as const;
export type TikTokRefreshQueueName = (typeof TIKTOK_REFRESH_SLOTS)[number];

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
const THROTTLE_DEFER_MS = 5 * 60_000;

const tiktokRefreshWorker = createAdapterBatchLaneWorker({
  adapterKind: "tiktok_account",
  slots: TIKTOK_REFRESH_SLOTS,
  fallthrough: TIKTOK_REFRESH_SLOTS,
  maxAttempts: MAX_ATTEMPTS,
  // Concurrency knob (NOT a batch-in-one-request size): claim up to N rows and
  // fetch them in parallel in dispatch.
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimTikTokThrottleSlot,
  dispatch: dispatchRefreshBatch,
  emitDrained: ({ queueName, entriesProcessed, durationMs }) => {
    logger.info({ queueName, entriesProcessed, durationMs }, "tiktok refresh lane: tick drained");
  },
});

export async function tiktokRefreshQueueTick(): Promise<AdapterBatchLaneWorkerTickResult> {
  return tiktokRefreshWorker.tick();
}

// Throttle gate: NOT a reserve (the single reserve happens inside fetchPostByUrl),
// so no double-charge. It distinguishes the two "exhausted" states:
//   - Prepaid balance <= 0 is the MONOTONIC hard ceiling — it never resets, so a
//     defer would loop forever and the RefreshNowButton would spin indefinitely.
//     RUN instead: dispatch's in-fetch reserve fails → a non-ok snapshot → the row
//     completes and the button settles (post shows unavailable).
//   - Daily cap >= 95% (balance still funded) resets at midnight Pacific — DEFER.
async function claimTikTokThrottleSlot(
  _ctx: AdapterLaneClaimGateContext<TikTokRefreshQueueName>,
): Promise<AdapterLaneClaimGateResult> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    "tiktok",
    "scrapecreators",
  );
  if (prepaidBalance <= 0) return { action: "run" };
  if (dailyCap > 0 && creditsUsed >= Math.floor(dailyCap * 0.95)) {
    return { action: "defer", retryAfterMs: THROTTLE_DEFER_MS, reason: "tiktok daily cap at 95%" };
  }
  return { action: "run" };
}

// allSettled + per-row snapshot + NEVER throw → the lane worker marks every claimed
// row `done` (independent posts; a per-row failure must not re-fetch the successes
// via a batch-wide throw-to-retry).
async function dispatchRefreshBatch(rows: AdapterLaneWorkerRow[]): Promise<void> {
  await Promise.allSettled(rows.map((row) => processOne(row)));
}

interface ResolvedPost {
  awemeId: string;
  permalink: string;
}

async function processOne(row: AdapterLaneWorkerRow): Promise<void> {
  try {
    const resolved =
      row.queueName === "service_post"
        ? await resolveServicePostRow(row)
        : await resolveUserPostRow(row);
    if (resolved === null) return; // skip reasons are logged inside the resolvers
    // user_post → user pool (the clicking user pays); service_post → cron pool
    // (operator-funded warm auto-refresh).
    const origin = row.queueName === "service_post" ? "cron" : "user";
    await refreshPost(resolved.awemeId, resolved.permalink, origin);
  } catch (err) {
    // A resolution failure (a DB select threw) has no awemeId yet → it can't write
    // a snapshot, so LOG it here. refreshPost owns its own non-ok snapshot for
    // fetch/write failures (it has the awemeId). The row still completes `done`;
    // recovery is the warm predicate re-selecting the stale post (auto path) or a
    // manual re-click (user_post).
    logger.warn(
      { rowId: row.id, queueName: row.queueName, err: String((err as Error)?.message ?? err) },
      "tiktok refresh: row failed before snapshot — recovered by re-selection",
    );
  }
}

// MANUAL path: resolve the aweme id from the event, TENANT-SCOPED. A row without a
// userId can't be safely scoped (refresh-now rows always carry one).
async function resolveUserPostRow(row: AdapterLaneWorkerRow): Promise<ResolvedPost | null> {
  if (row.userId === null) return null;
  const eventId = row.payload?.event_id;
  if (typeof eventId !== "string") return null;
  const [event] = await db
    .select({ externalId: events.externalId })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.userId, row.userId),
        eq(events.kind, "tiktok_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  const awemeId = event?.externalId ?? null;
  if (awemeId === null) return null;
  return resolvePermalink(awemeId);
}

// CRON warm path: the aweme id is in the payload directly. PUBLIC-DATA — no event
// lookup, no userId.
async function resolveServicePostRow(row: AdapterLaneWorkerRow): Promise<ResolvedPost | null> {
  const awemeId = row.payload?.post_id;
  if (typeof awemeId !== "string") return null;
  return resolvePermalink(awemeId);
}

// The single-video endpoint needs the permalink, which lives on the public-data
// tiktok_posts row. No row / no permalink (e.g. a paste before the first account
// poll) → graceful skip; the next scheduled poll fills it.
async function resolvePermalink(awemeId: string): Promise<ResolvedPost | null> {
  const [postRow] = await db
    .select({ permalink: tiktokPosts.permalink })
    .from(tiktokPosts)
    .where(eq(tiktokPosts.awemeId, awemeId))
    .limit(1);
  const permalink = postRow?.permalink ?? null;
  if (permalink === null) {
    logger.info({ awemeId }, "tiktok refresh: post not cached yet — skip");
    return null;
  }
  return { awemeId, permalink };
}

// Fetch one post + write its snapshot. Owns its own try/catch so a per-row failure
// lands a VISIBLE non-ok snapshot (stamps last_polled_at — the manual button
// settles; the warm predicate's poll_failure_count bound advances) and NEVER throws.
// `origin` picks the credit pool (user vs cron).
async function refreshPost(
  awemeId: string,
  permalink: string,
  origin: "cron" | "user",
): Promise<void> {
  const provider = getSocialProvider("tiktok");
  if (provider === null) return; // unconfigured — isEnabled gates the lane; defensive.

  try {
    // fetchPostByUrl reserves one prepaid credit internally from the `origin` pool.
    const post = await provider.fetchPostByUrl("tiktok", permalink, { origin });
    if (post === null) {
      // Deleted / private — the envelope carried no aweme object.
      await writeSnapshot({ awemeId, permalink, metrics: null, status: "not_found" });
      return;
    }
    await writeSnapshot({
      awemeId,
      accountId: post.ownerId,
      mediaType: post.kind,
      caption: post.caption,
      permalink,
      thumbnailUrl: post.thumbnailUrl,
      publishedAt: post.publishedAt,
      metrics: {
        views: post.metrics.views,
        likes: post.metrics.likes,
        comments: post.metrics.comments,
        shares: post.metrics.shares,
      },
      status: "ok",
    });
  } catch (err) {
    const status =
      err instanceof AdapterError ? categoryToSnapshotStatus(err.category) : "auth_error";
    if (!(err instanceof AdapterError)) {
      logger.warn(
        { awemeId, err: String((err as Error)?.message ?? err) },
        "tiktok refresh: unexpected error",
      );
    }
    await writeSnapshot({ awemeId, permalink, metrics: null, status }).catch((e) => {
      logger.warn(
        { awemeId, err: String((e as Error)?.message ?? e) },
        "tiktok refresh: snapshot write failed",
      );
    });
  }
}

export function __resetTikTokRefreshQueueWorkerForTest(): void {
  tiktokRefreshWorker.resetForTest();
}

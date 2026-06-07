// Instagram per-post stats refresh — SQL lane worker (#69 follow-on).
//
// Manual "Refresh now" enqueues ONE adapter_refresh_queue row per post
// (enqueueRefreshNow, queue_name "user_post"). This worker claims up to N rows
// per tick (N = env.SOCIAL_REFRESH_LANE_CONCURRENCY; batchScope "global" — across
// users) and refreshes them CONCURRENTLY: Instagram's single-post endpoint can't
// batch (1 request = 1 post), so scale comes from concurrency, not a multi-id
// call like YouTube's videos.list.
//
// Each post is independent, so dispatch uses Promise.allSettled and writes a
// per-post snapshot (ok or non-ok via categoryToSnapshotStatus) and NEVER throws
// — the lane worker then marks every claimed row `done` (no batch-wide retry that
// would re-fetch the successes). A transient failure (429/network) lands a non-ok
// snapshot — which still stamps instagram_posts.last_polled_at, so the
// RefreshNowButton stop-loop settles — and is recovered by the user re-clicking
// after cooldown or the next scheduled source poll.
//
// The credit reserve happens INSIDE provider.fetchPostByUrl (origin "user"), so
// claimGate is a throttle gate ONLY (defer at 95%), never a second reserve —
// avoiding a double-charge (plan D2).

import { and, eq, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
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
import { getSocialThrottleState } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";

export const INSTAGRAM_REFRESH_SLOTS = ["user_post"] as const;
export type InstagramRefreshQueueName = (typeof INSTAGRAM_REFRESH_SLOTS)[number];

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
const THROTTLE_DEFER_MS = 5 * 60_000;

const instagramRefreshWorker = createAdapterBatchLaneWorker({
  adapterKind: "instagram_account",
  slots: INSTAGRAM_REFRESH_SLOTS,
  fallthrough: INSTAGRAM_REFRESH_SLOTS,
  maxAttempts: MAX_ATTEMPTS,
  // Concurrency knob (NOT a batch-in-one-request size): claim up to N rows and
  // fetch them in parallel in dispatch.
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimInstagramThrottleSlot,
  dispatch: dispatchRefreshBatch,
});

export async function instagramRefreshQueueTick(): Promise<AdapterBatchLaneWorkerTickResult> {
  return instagramRefreshWorker.tick();
}

// Throttle gate (D2): defer the tick when the operator budget pool is at 95% —
// consistent with the IG adapter's refreshQueue.canRun. NOT a reserve (the single
// reserve happens inside fetchPostByUrl), so no double-charge. Deferring (vs a
// non-ok snapshot) keeps the rows pending so they refresh once the pool frees.
async function claimInstagramThrottleSlot(
  _ctx: AdapterLaneClaimGateContext<InstagramRefreshQueueName>,
): Promise<AdapterLaneClaimGateResult> {
  const throttle = await getSocialThrottleState("instagram", "scrapecreators");
  if (throttle === "ninetyfive") {
    return { action: "defer", retryAfterMs: THROTTLE_DEFER_MS, reason: "instagram budget at 95%" };
  }
  return { action: "run" };
}

// allSettled + per-row snapshot + NEVER throw → the lane worker marks every
// claimed row `done` (independent posts; a per-row failure must not re-fetch the
// successes).
async function dispatchRefreshBatch(rows: AdapterLaneWorkerRow[]): Promise<void> {
  await Promise.allSettled(rows.map((row) => processOne(row)));
}

async function processOne(row: AdapterLaneWorkerRow): Promise<void> {
  // Tenant-scope P0 (S1): a row without a userId can't be safely scoped — skip,
  // mirroring youtube/refresh-queue-tick.ts. Refresh-now rows always carry one.
  if (row.userId === null) return;
  const eventId = row.payload?.event_id;
  if (typeof eventId !== "string") return;

  // Resolve the post's media id from the event, tenant-scoped.
  const [event] = await db
    .select({ externalId: events.externalId })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.userId, row.userId),
        eq(events.kind, "instagram_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  const postId = event?.externalId ?? null;
  if (postId === null) return;

  // The single-post endpoint needs the shortcode permalink, which lives on the
  // public-data instagram_posts row. No row / no permalink (e.g. a paste before
  // the first account poll) → graceful skip; the next scheduled poll fills it (D4).
  const [postRow] = await db
    .select({ permalink: instagramPosts.permalink })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, postId))
    .limit(1);
  const permalink = postRow?.permalink ?? null;
  if (permalink === null) {
    logger.info({ eventId, postId }, "instagram refresh: post not cached yet — skip");
    return;
  }

  const provider = getSocialProvider("instagram");
  if (provider === null) return; // unconfigured — isEnabled gates the lane; defensive.

  try {
    // origin "user" → fetchPostByUrl reserves one prepaid credit internally.
    const post = await provider.fetchPostByUrl("instagram", permalink, { origin: "user" });
    if (post === null) {
      // Deleted / private — the envelope carried no media object.
      await writeSnapshot({ postId, permalink, metrics: null, status: "not_found" });
      return;
    }
    await writeSnapshot({
      postId,
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
      },
      status: "ok",
    });
  } catch (err) {
    // Per-row failure → write a non-ok snapshot so last_polled_at is stamped (the
    // button stop-loop settles) and the failure is VISIBLE — never a silent drop
    // (P2-A). The row is still marked done (no batch-wide retry that would
    // re-fetch the successes); recovery is a re-click after cooldown or the next
    // scheduled source poll. An AdapterError maps to its category; an unexpected
    // throw (e.g. a programmer bug) degrades to "auth_error" and is logged.
    const status =
      err instanceof AdapterError ? categoryToSnapshotStatus(err.category) : "auth_error";
    if (!(err instanceof AdapterError)) {
      logger.warn(
        { eventId, postId, err: String((err as Error)?.message ?? err) },
        "instagram refresh: unexpected error",
      );
    }
    // Best-effort: if the original failure WAS the snapshot write (DB down), this
    // re-write also fails — swallow so the row still completes, don't re-throw.
    await writeSnapshot({ postId, permalink, metrics: null, status }).catch((e) => {
      logger.warn(
        { postId, err: String((e as Error)?.message ?? e) },
        "instagram refresh: snapshot write failed",
      );
    });
  }
}

export function __resetInstagramRefreshQueueWorkerForTest(): void {
  instagramRefreshWorker.resetForTest();
}

// Reddit batch-worker tick — the 8-slot round-robin loop.
//
// Called every 7.5s. One tick = at most one Reddit HTTP call, enforcing
// an 8 req/min effective ceiling — Reddit's public-`.json` rate cap is
// 10 req/min, so we sit two slots below it for safety margin.
//
// Each tick picks a queue lane from REDDIT_SLOT_MAPPING (indexed by
// tickCounter % 8), claims one pending row via FOR UPDATE SKIP LOCKED,
// dispatches to the type-specific handler, and marks the row's
// terminal state. When the slot's lane is empty, the tick falls through
// to FALLTHROUGH_ORDER so we never burn a slot doing nothing.
//
// Slot distribution per minute: 1×service_source, 1×service_post,
// 3×user_source, 3×user_post — user-driven work gets six of the eight
// slots since users care about latency more than cron does.
//
// Per-lane batching (maxBatchSize):
//   - service_source / user_source (sub_poll / author_poll): 1.
//     Each row needs its own /r/<sub>/new.json or /user/<h>/submitted.json
//     listing fetch and a single tick only acquires one pacer slot.
//   - service_post / user_post (post_single via /api/info): up to 100.
//     Reddit's /api/info accepts batched id lists; one tick = one HTTP
//     = up to 100 fresh snapshots.

import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterLaneClaimGateResult,
  type AdapterLaneDispatchContext,
  type AdapterLaneClaimGateContext,
  type AdapterLaneWorkerRow,
  type AdapterLaneWorkerTickResult,
} from "$lib/server/services/adapter-lane-worker.js";
import { handleSubPoll } from "./sub-poll.js";
import { handleAuthorPoll } from "./author-poll.js";
import { handlePostsRefresh } from "./posts-refresh.js";
import { resolveOperatorUserId, __resetOperatorIdCacheForTest } from "../operator-resolver.js";
import { acquireRedditPacerSlotWith } from "../pacer.js";

type RedditPacerPermit = { pacer: "already-acquired" };

/** Reddit /api/info hard limit on id-list length per request. Drives
 *  per-lane maxBatchSize for the post lanes. */
const REDDIT_POST_BATCH_LIMIT = 100;

export const REDDIT_SLOT_MAPPING = [
  "service_source",
  "user_source",
  "user_post",
  "user_source",
  "service_post",
  "user_post",
  "user_source",
  "user_post",
] as const;

export const FALLTHROUGH_ORDER = [
  "user_post",
  "user_source",
  "service_post",
  "service_source",
] as const;

export type RedditQueueName = (typeof REDDIT_SLOT_MAPPING)[number];

/** Max retries before a row is moved to dead_letter. The pending row's
 *  attempts column tracks the count; a permanent AdapterError
 *  short-circuits to dead_letter regardless of attempts. */
const MAX_ATTEMPTS = 5;

export type RedditWorkerTickResult = AdapterLaneWorkerTickResult;

/** One worker tick. Picks the slot's queue (or falls through to next
 *  non-empty queue in priority order), claims one pending row via
 *  FOR UPDATE SKIP LOCKED, dispatches to handler, marks the row's
 *  terminal state.
 *
 *  Returns the queue + type of the processed row (for telemetry +
 *  reddit.queue_drained audit accumulation), or all-nulls when every
 *  queue is empty this tick. */
/** Stale-processing recovery window. A row in status='processing'
 *  older than this is assumed to belong to a crashed worker process
 *  and is flipped back to 'pending' so the dequeue can re-claim it.
 *  5 minutes is longer than any healthy handler run (~1-2s) and
 *  shorter than cron intervals (≥4h), so a slow-but-alive worker is
 *  NOT preempted. The `attempts` column was already incremented when
 *  the row was claimed, so a stale row that flips back to pending and
 *  re-fails N more times still hits MAX_ATTEMPTS dead-letter. */
const STALE_PROCESSING_MS = 5 * 60_000;

/** How often the stale-processing recovery scan runs. The worker tick
 *  itself fires every 7.5s; running the recovery UPDATE on every tick
 *  is ~12k no-op UPDATEs/day. Gating to once/minute drops that to
 *  ~1.5k and keeps the no-op cheap regardless of queue size. */
const STALE_RECOVERY_INTERVAL_MS = 60_000;

const redditLaneWorker = createAdapterBatchLaneWorker<RedditQueueName, RedditPacerPermit>({
  adapterKind: "reddit_account",
  slots: REDDIT_SLOT_MAPPING,
  fallthrough: FALLTHROUGH_ORDER,
  maxAttempts: MAX_ATTEMPTS,
  // Per-lane batch limit: post lanes batch via /api/info (≤100 IDs),
  // listing lanes stay single-row (each call has its own endpoint).
  // Lanes omitted default to 1 — same effect as explicit 1.
  maxBatchSize: {
    service_post: REDDIT_POST_BATCH_LIMIT,
    user_post: REDDIT_POST_BATCH_LIMIT,
  },
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimRedditPacerSlot,
  dispatch: dispatchByLane,
  emitDrained(stats) {
    // Fire-and-forget audit row so /admin/quota Reddit observability
    // (getDailyStats reads audit_log.action='reddit.queue_drained' to
    // populate the unitsUsed counter) sees this work. Without the
    // emit, /admin's daily Reddit stat would stay 0 regardless of
    // worker activity. Best-effort: writes a single audit row per
    // processed tick; failures don't block the worker.
    void emitQueueDrainedAudit(stats);
  },
});

/** Adapt the batch worker's tick result back to the singular shape
 *  Reddit's public API has shipped with. The batch worker always
 *  returns arrays; for Reddit:
 *   - service_post / user_post lanes: rows length 1..100 — caller
 *     observes the FIRST row's type/id (telemetry only — not used to
 *     drive any logic; the per-row terminal state is set inside the
 *     factory regardless of result shape).
 *   - other lanes: rows length 1 by config.
 *  This wrapper preserves the existing test surface
 *  (`result.processedType` / `result.processedId`) while the storage
 *  evolves under it. */
export async function redditWorkerTick(): Promise<RedditWorkerTickResult> {
  const r = await redditLaneWorker.tick();
  return {
    processedQueue: r.processedQueue,
    processedType: r.processedTypes[0] ?? null,
    processedId: r.processedIds[0] ?? null,
  };
}

async function claimRedditPacerSlot(
  ctx: AdapterLaneClaimGateContext<RedditQueueName>,
): Promise<AdapterLaneClaimGateResult<RedditPacerPermit>> {
  const slot = await acquireRedditPacerSlotWith(ctx.tx);
  if (slot.acquired) {
    return { action: "run", permit: { pacer: "already-acquired" } };
  }
  return {
    action: "defer",
    retryAfterMs: slot.waitMs,
    reason: slot.paused ? "reddit adapter paused" : "reddit global pacer busy",
  };
}

/** Dispatch claimed rows for the current tick.
 *
 *  Listing lanes (service_source / user_source) always carry exactly
 *  one row (maxBatchSize=1 by config). Post lanes
 *  (service_post / user_post) may carry up to 100; we collect their
 *  post_ids and make ONE `/api/info` call via handlePostsRefresh.
 *
 *  All rows in a single dispatch call belong to the same queue lane
 *  (the factory claims them per-lane). Mixing types within a single
 *  claimed batch would be a factory-level bug — sub_poll / author_poll
 *  paths assert `rows.length === 1` defensively in case a future
 *  maxBatchSize misconfig (>1 for a listing lane) leaks through. */
async function dispatchByLane(
  rows: AdapterLaneWorkerRow[],
  ctx: AdapterLaneDispatchContext<RedditPacerPermit>,
): Promise<void> {
  if (rows.length === 0) return;
  const pacer = ctx.permit?.pacer ?? "acquire";
  const first = rows[0]!;

  // Listing lanes: maxBatchSize=1 ensures one row exactly. We assert
  // here because the factory has no per-type batch enforcement — a
  // misconfigured policy that sets `maxBatchSize.service_source = 2`
  // would silently waste the second claim. Permanent error dead-
  // letters the rows and surfaces the bug loudly.
  if (first.type === "sub_poll") {
    if (rows.length > 1) {
      throw new AdapterError(
        `sub_poll dispatch claimed ${rows.length} rows; listing lanes require maxBatchSize=1`,
        { category: "permanent" },
      );
    }
    const sub = first.payload?.sub as string | undefined;
    if (typeof sub !== "string") {
      throw new AdapterError("sub_poll payload missing 'sub'", { category: "permanent" });
    }
    await handleSubPoll({ sub, userId: first.userId, pacer });
    return;
  }
  if (first.type === "author_poll") {
    if (rows.length > 1) {
      throw new AdapterError(
        `author_poll dispatch claimed ${rows.length} rows; listing lanes require maxBatchSize=1`,
        { category: "permanent" },
      );
    }
    const handle = first.payload?.handle as string | undefined;
    if (typeof handle !== "string") {
      throw new AdapterError("author_poll payload missing 'handle'", {
        category: "permanent",
      });
    }
    await handleAuthorPoll({ handle, userId: first.userId, pacer });
    return;
  }

  // Post lanes: claim-time batch via /api/info. All rows of this
  // dispatch share the same lane (and hence the same `type`); collect
  // their post_ids and make ONE upstream call.
  if (first.type === "post_single") {
    const postIds: string[] = [];
    for (const row of rows) {
      const postId = row.payload?.post_id as string | undefined;
      if (typeof postId !== "string") {
        throw new AdapterError("post_single payload missing 'post_id'", {
          category: "permanent",
        });
      }
      postIds.push(postId);
    }
    // Single-row claims still flow through handlePostsRefresh — same
    // endpoint, identical behavior; cache writes are idempotent. One
    // code path for "fetch post info via /api/info" regardless of
    // batch size.
    await handlePostsRefresh({ postIds, userId: first.userId, pacer });
    return;
  }

  throw new AdapterError(`unknown queue row type: ${first.type}`, { category: "permanent" });
}

/** Emit `reddit.queue_drained` audit row (best-effort). Caller typically
 *  accumulates per-minute stats and invokes once per non-empty tick
 *  window. Failed audit writes are logged at WARN; never throw upward.
 *
 *  Requires a non-empty ADMIN_EMAIL_ALLOWLIST so writeAudit can resolve
 *  an operator user_id; without it, this is a no-op (silently). */
export async function emitQueueDrainedAudit(stats: {
  queueName: string;
  entriesProcessed: number;
  durationMs: number;
}): Promise<void> {
  if (stats.entriesProcessed === 0) return;
  try {
    const operatorId = await resolveOperatorUserId();
    if (operatorId === null) {
      logger.debug({ stats }, "reddit.queue_drained: no operator resolvable; skipping audit");
      return;
    }
    await writeAudit({
      userId: operatorId,
      action: "reddit.queue_drained",
      ipAddress: "127.0.0.1",
      metadata: {
        queue_name: stats.queueName,
        entries_processed: stats.entriesProcessed,
        duration_ms: stats.durationMs,
      },
    });
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err) },
      "reddit.queue_drained audit emit failed",
    );
  }
}

/** Test-only helper — resets the tick counter and cached operator id so
 *  each test case starts from slot 1. Not exported through any barrel;
 *  only the worker-tick.test.ts file imports it. */
export function __resetTickCounterForTest(): void {
  redditLaneWorker.resetForTest();
  __resetOperatorIdCacheForTest();
}

/** Test-only helper — set the tick counter to advance to a specific slot
 *  without firing the prior slots. Slot index is 0-based here (slot 1
 *  in the docs = slotIndex 0). */
export function __setTickCounterForTest(slotIndex: number): void {
  redditLaneWorker.setSlotForTest(slotIndex);
}

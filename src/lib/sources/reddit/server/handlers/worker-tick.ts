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

import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import {
  createAdapterLaneWorker,
  type AdapterLaneClaimGateResult,
  type AdapterLaneDispatchContext,
  type AdapterLaneClaimGateContext,
  type AdapterLaneWorkerRow,
  type AdapterLaneWorkerTickResult,
} from "$lib/server/services/adapter-lane-worker.js";
import { handleSubPoll } from "./sub-poll.js";
import { handleAuthorPoll } from "./author-poll.js";
import { handlePostBatch } from "./post-batch.js";
import { handlePostSingle } from "./post-single.js";
import { resolveOperatorUserId, __resetOperatorIdCacheForTest } from "../operator-resolver.js";
import { acquireRedditPacerSlotWith } from "../pacer.js";

type RedditPacerPermit = { pacer: "already-acquired" };

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

const redditLaneWorker = createAdapterLaneWorker<RedditQueueName, RedditPacerPermit>({
  adapterKind: "reddit_account",
  slots: REDDIT_SLOT_MAPPING,
  fallthrough: FALLTHROUGH_ORDER,
  maxAttempts: MAX_ATTEMPTS,
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimRedditPacerSlot,
  dispatch: dispatchByType,
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

export async function redditWorkerTick(): Promise<RedditWorkerTickResult> {
  return redditLaneWorker.tick();
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

/** Dispatch by row.type — one of sub_poll / author_poll / post_batch /
 *  post_single. Unknown type throws (will dead_letter via the catch
 *  branch in tryClaimAndDispatch). */
async function dispatchByType(
  row: AdapterLaneWorkerRow,
  ctx: AdapterLaneDispatchContext<RedditPacerPermit>,
): Promise<void> {
  const pacer = ctx.permit?.pacer ?? "acquire";
  switch (row.type) {
    case "sub_poll": {
      const sub = row.payload?.sub as string | undefined;
      if (typeof sub !== "string") {
        throw new AdapterError("sub_poll payload missing 'sub'", { category: "permanent" });
      }
      await handleSubPoll({ sub, userId: row.userId, pacer });
      return;
    }
    case "author_poll": {
      const handle = row.payload?.handle as string | undefined;
      if (typeof handle !== "string") {
        throw new AdapterError("author_poll payload missing 'handle'", {
          category: "permanent",
        });
      }
      await handleAuthorPoll({ handle, userId: row.userId, pacer });
      return;
    }
    case "post_batch": {
      const postIds = row.payload?.post_ids as string[] | undefined;
      if (!Array.isArray(postIds)) {
        throw new AdapterError("post_batch payload missing 'post_ids'", {
          category: "permanent",
        });
      }
      await handlePostBatch({ postIds, userId: row.userId, pacer });
      return;
    }
    case "post_single": {
      const postId = row.payload?.post_id as string | undefined;
      if (typeof postId !== "string") {
        throw new AdapterError("post_single payload missing 'post_id'", {
          category: "permanent",
        });
      }
      await handlePostSingle({ postId, userId: row.userId, pacer });
      return;
    }
    default:
      throw new AdapterError(`unknown queue row type: ${row.type}`, { category: "permanent" });
  }
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

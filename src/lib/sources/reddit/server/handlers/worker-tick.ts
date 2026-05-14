// Reddit batch-worker tick body — the 8-slot round-robin loop.
//
// Called every 7.5s by src/worker/index.ts (plan 07 wires the setInterval).
// Per tick: determine current slot (tickCounter % 8) → lookup target
// queue in REDDIT_SLOT_MAPPING → SELECT FOR UPDATE SKIP LOCKED 1 pending
// row → if empty, fall through to next non-empty queue in
// FALLTHROUGH_ORDER → dispatch to type-specific handler → mark row
// status and increment attempts on failure.
//
// This pattern is the load-bearing answer to Reddit's 10 req/min hard
// limit (D-RDT-7): the worker fires AT MOST 1 HTTP call per 7.5s = 8
// req/min effective ceiling. SELECT FOR UPDATE SKIP LOCKED ensures
// multi-instance deploys cannot double-claim the same row.
//
// Slot mapping (D-RDT-QUEUES-V2):
//   1: service_source   5: service_post
//   2: user_source      6: user_post
//   3: user_post        7: user_source
//   4: user_source      8: user_post
//
// Fallthrough (when slot's target queue is empty):
//   user_post → user_source → service_post → service_source
//
// Per-minute distribution: 1×service_source, 1×service_post,
// 3×user_source, 3×user_post.

import { db } from "$lib/server/db/client.js";
import { sql } from "drizzle-orm";
import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { handleSubPoll } from "./sub-poll.js";
import { handleAuthorPoll } from "./author-poll.js";
import { handlePostBatch } from "./post-batch.js";
import { handlePostSingle } from "./post-single.js";

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

/** Module-scope tick counter — increments each call; mod 8 → slot index.
 *  Module-scope is acceptable under DV-RDT-7 because D-RDT-WORKER is
 *  single-process (env's WORKER_REPLICA_COUNT guard rejects N>1 when any
 *  adapter sets usesInProcessRateLimiter=true). A worker restart resets
 *  the counter — at worst we re-process slot 1 next tick instead of slot
 *  N+1; the SQL FOR UPDATE SKIP LOCKED still prevents duplicates. */
let tickCounter = 0;

export interface RedditWorkerTickResult {
  processedQueue: string | null;
  processedType: string | null;
  processedId: number | null;
}

interface ClaimedRow {
  // bigserial comes back from tx.execute() as a JS string in some
  // node-pg configurations; we coerce to Number at the row-read boundary
  // (line ~134 below) so downstream consumers always see a number.
  id: number;
  type: string;
  payload: Record<string, unknown>;
  user_id: string | null;
  attempts: number;
}

/** One worker tick. Picks the slot's queue (or falls through to next
 *  non-empty queue in priority order), claims one pending row via
 *  FOR UPDATE SKIP LOCKED, dispatches to handler, marks the row's
 *  terminal state.
 *
 *  Returns the queue + type of the processed row (for telemetry +
 *  reddit.queue_drained audit accumulation), or all-nulls when every
 *  queue is empty this tick. */
export async function redditWorkerTick(): Promise<RedditWorkerTickResult> {
  const slot = REDDIT_SLOT_MAPPING[tickCounter % 8]!;
  tickCounter++;

  const queueOrder = [slot, ...FALLTHROUGH_ORDER.filter((q) => q !== slot)];

  for (const queueName of queueOrder) {
    const claimed = await tryClaimAndDispatch(queueName);
    if (claimed !== null) {
      return {
        processedQueue: queueName,
        processedType: claimed.type,
        processedId: claimed.id,
      };
    }
  }
  return { processedQueue: null, processedType: null, processedId: null };
}

/** Claim one pending row from `queueName` via FOR UPDATE SKIP LOCKED;
 *  dispatch to the type-specific handler; mark terminal state inside
 *  the same tx so the row's status reflects the handler's outcome
 *  atomically.
 *
 *  Returns the claimed row's {id,type} on success, or null when the
 *  queue had no pending rows (caller falls through to the next queue). */
async function tryClaimAndDispatch(
  queueName: string,
): Promise<{ id: number; type: string } | null> {
  // Phase 1 — SHORT transaction. Atomically pick + mark processing +
  // increment attempts, then COMMIT. The tx holds a row lock for only
  // the duration of one UPDATE; the connection returns to the pool
  // before any HTTP work fires.
  //
  // Why split: holding `tx` across `dispatchByType` (which does a
  // Reddit fetch + 4 UPSERTs + a snapshot write) ties up a DB
  // connection for the full handler duration and serializes
  // FOR UPDATE work behind slow network. The split makes the claim
  // O(ms) and lets the connection pool serve other queries while
  // the handler is in flight.
  //
  // Crash recovery: a worker process crashing AFTER claim + COMMIT but
  // BEFORE the terminal UPDATE leaves status='processing'. The
  // stale-processing recovery in handleDeletionPropagationCron (or a
  // future dedicated cron) can scan `WHERE status='processing' AND
  // last_attempt_at < NOW() - 5min` and flip back to 'pending' —
  // safe because attempts was incremented, so retries don't loop.
  const row = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, type, payload, user_id, attempts
      FROM reddit_refresh_queue
      WHERE queue_name = ${queueName}
        AND status = 'pending'
      ORDER BY priority ASC, enqueued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const queryResult = rows as unknown as {
      rows?: Array<Omit<ClaimedRow, "id"> & { id: number | string }>;
    };
    const rawRow = queryResult.rows?.[0];
    if (!rawRow) return null;
    // Coerce bigserial id from string → number at the row-read boundary
    // (node-pg returns bigint/bigserial as strings). Downstream callers
    // (test harness, observability, handlers) expect number.
    const claimed: ClaimedRow = { ...rawRow, id: Number(rawRow.id) };
    await tx.execute(sql`
      UPDATE reddit_refresh_queue
      SET status = 'processing',
          last_attempt_at = NOW(),
          attempts = attempts + 1
      WHERE id = ${claimed.id}
    `);
    return claimed;
  });

  if (row === null) return null;
  const newAttempts = row.attempts + 1;

  // Phase 2 — HTTP + DB work OUTSIDE any transaction. handlePostSingle
  // and the other type-handlers each manage their own UPSERT semantics;
  // the worker's only job here is to mark the terminal state once they
  // complete (or fail).
  try {
    await dispatchByType(row);
    await db.execute(sql`UPDATE reddit_refresh_queue SET status = 'done' WHERE id = ${row.id}`);
  } catch (err) {
    const isPermanent =
      err instanceof AdapterError && (err.category === "permanent" || err.category === "not-found");
    if (isPermanent || newAttempts >= MAX_ATTEMPTS) {
      await db.execute(
        sql`UPDATE reddit_refresh_queue SET status = 'dead_letter' WHERE id = ${row.id}`,
      );
    } else {
      // Re-queue. attempts was already incremented in phase 1, so a
      // transient handler crash retries up to MAX_ATTEMPTS but cannot
      // loop indefinitely.
      await db.execute(
        sql`UPDATE reddit_refresh_queue SET status = 'pending' WHERE id = ${row.id}`,
      );
    }
    logger.warn(
      {
        queueName,
        type: row.type,
        id: row.id,
        category: err instanceof AdapterError ? err.category : "non-adapter",
        attempts: newAttempts,
        err: String((err as Error)?.message ?? err),
      },
      "reddit worker tick: handler failed",
    );
  }
  return { id: row.id, type: row.type };
}

/** Dispatch by row.type — one of sub_poll / author_poll / post_batch /
 *  post_single. Unknown type throws (will dead_letter via the catch
 *  branch in tryClaimAndDispatch). */
async function dispatchByType(row: ClaimedRow): Promise<void> {
  switch (row.type) {
    case "sub_poll": {
      const sub = row.payload?.sub as string | undefined;
      if (typeof sub !== "string") {
        throw new AdapterError("sub_poll payload missing 'sub'", { category: "permanent" });
      }
      await handleSubPoll({ sub, userId: row.user_id });
      return;
    }
    case "author_poll": {
      const handle = row.payload?.handle as string | undefined;
      if (typeof handle !== "string") {
        throw new AdapterError("author_poll payload missing 'handle'", {
          category: "permanent",
        });
      }
      await handleAuthorPoll({ handle, userId: row.user_id });
      return;
    }
    case "post_batch": {
      const postIds = row.payload?.post_ids as string[] | undefined;
      if (!Array.isArray(postIds)) {
        throw new AdapterError("post_batch payload missing 'post_ids'", {
          category: "permanent",
        });
      }
      await handlePostBatch({ postIds, userId: row.user_id });
      return;
    }
    case "post_single": {
      const postId = row.payload?.post_id as string | undefined;
      if (typeof postId !== "string") {
        throw new AdapterError("post_single payload missing 'post_id'", {
          category: "permanent",
        });
      }
      await handlePostSingle({ postId, userId: row.user_id });
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

/** Cached operator user_id resolved from ADMIN_EMAIL_ALLOWLIST[0].
 *  Mirrors http.ts's resolveOperatorUserId for consistent audit identity
 *  across reddit.* verbs. `undefined` = not yet resolved; `null` =
 *  resolved-empty; string = resolved successfully. */
let cachedOperatorId: string | null | undefined = undefined;

async function resolveOperatorUserId(): Promise<string | null> {
  if (cachedOperatorId !== undefined) return cachedOperatorId;
  const { env } = await import("$lib/server/config/env.js");
  const allowlist = [...env.ADMIN_EMAIL_ALLOWLIST];
  if (allowlist.length === 0) {
    cachedOperatorId = null;
    return null;
  }
  const { user } = await import("$lib/server/db/schema/auth.js");
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${allowlist[0]}`)
    .limit(1);
  cachedOperatorId = rows[0]?.id ?? null;
  return cachedOperatorId;
}

/** Test-only helper — resets the tick counter and cached operator id so
 *  each test case starts from slot 1. Not exported through any barrel;
 *  only the worker-tick.test.ts file imports it. */
export function __resetTickCounterForTest(): void {
  tickCounter = 0;
  cachedOperatorId = undefined;
}

/** Test-only helper — set the tick counter to advance to a specific slot
 *  without firing the prior slots. Slot index is 0-based here (slot 1
 *  in the docs = slotIndex 0). */
export function __setTickCounterForTest(slotIndex: number): void {
  tickCounter = slotIndex;
}

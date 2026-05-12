// Outbox forwarder.
//
// Long-running async loop in the worker process that translates pending
// `outbox` rows into pg-boss `boss.send` calls. Two wake-up sources:
//
//   1. Postgres LISTEN on 'outbox.new' channel — triggered by the
//      AFTER-INSERT trigger. Instant pickup (typically <10ms after commit).
//
//   2. Periodic sweep every 30s — durability backstop in case the
//      LISTEN connection drops silently (TCP timeout, pg restart),
//      or in case a NOTIFY was missed during forwarder restart.
//
// Delivery semantics: at-least-once. The forwarder calls boss.send
// FIRST, then UPDATEs forwarded_at = now(). If the process crashes
// between the two, the next sweep re-sends. pg-boss singletonKey in
// outbox.options dedupes those rare duplicates; downstream handlers
// must be idempotent.
//
// Concurrency safety:
//   - drainInFlight mutex prevents two drain() calls from running
//     concurrently within the same process (NOTIFY trigger + 30s
//     interval would otherwise both pick up the same rows).
//   - Atomic row claim via UPDATE ... WHERE id IN (SELECT ... FOR
//     UPDATE SKIP LOCKED) RETURNING bumps last_attempt_at in the
//     same statement that selects the row — concurrent claimers
//     (different processes / replicas) skip rows that another
//     process is currently working on, because the WHERE clause
//     excludes rows with last_attempt_at > now() - claim window.
//   - pg-boss singletonKey in outbox.options is the third belt:
//     even on duplicate boss.send, only one job runs.
//
// Failure handling: every failed forward attempt bumps
// forwarder_attempt + stores last_error / last_attempt_at. After
// MAX_ATTEMPTS the row stays pending forever — operator must
// manually investigate via SELECT (or extend this with a dead-letter
// dispatch later).

import { sql } from "drizzle-orm";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { db } from "../../lib/server/db/client.js";
import { outbox } from "../../lib/server/db/schema/outbox.js";
import { logger } from "../../lib/server/logger.js";
import { env } from "../../lib/server/config/env.js";

/** Forwarder LISTEN channel — must match `pg_notify('outbox.new', ...)`
 *  in the AFTER-INSERT trigger migration. */
const NOTIFY_CHANNEL = "outbox.new";
/** Periodic sweep interval. 30s gives <1m worst-case latency even when
 *  LISTEN drops; tight enough that an operator-introduced stuck row
 *  surfaces within a debug session. */
const SWEEP_INTERVAL_MS = 30_000;
/** Per-sweep batch size — keep modest so one slow batch doesn't block
 *  NOTIFY wakeups for unrelated jobs. */
const BATCH_SIZE = 50;
/** After this many failed attempts, the forwarder skips the row on
 *  subsequent sweeps (still SELECTed but boss.send not retried). Manual
 *  intervention required — increment the row's forwarder_attempt back
 *  below threshold OR delete to drop the intent. */
const MAX_ATTEMPTS = 20;
/** Atomic-claim window. A row whose last_attempt_at was bumped within
 *  this window is assumed "in flight" by another claimer and skipped.
 *  60s is long enough to cover normal boss.send latency (~10ms)
 *  including a stuck-network worst case, short enough that a crashed
 *  forwarder doesn't leave the row stuck for hours. */
const CLAIM_WINDOW_SECONDS = 60;

interface ClaimedRow {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  options: Record<string, unknown>;
  forwarder_attempt: number;
}

/** Process one batch of pending outbox rows. Returns the number of
 *  rows forwarded successfully. */
async function processOnce(boss: PgBoss): Promise<number> {
  // Atomic claim: the UPDATE acquires per-row locks via SKIP LOCKED in
  // the inner SELECT, and bumps last_attempt_at as the side effect that
  // makes the row "claimed" for the next CLAIM_WINDOW_SECONDS. A
  // concurrent claimer's SELECT excludes claimed rows via the WHERE
  // clause — atomic with no separate transaction handling needed.
  const result = await db.execute(sql`
    UPDATE outbox
    SET last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM outbox
      WHERE forwarded_at IS NULL
        AND forwarder_attempt < ${MAX_ATTEMPTS}
        AND (
          last_attempt_at IS NULL
          OR last_attempt_at < now() - (${CLAIM_WINDOW_SECONDS} * interval '1 second')
        )
      ORDER BY created_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, queue, payload, options, forwarder_attempt
  `);
  const rows = result.rows as unknown as ClaimedRow[];
  if (rows.length === 0) return 0;

  let forwarded = 0;
  for (const row of rows) {
    try {
      await boss.send(
        row.queue,
        row.payload as Parameters<typeof boss.send>[1],
        row.options as Parameters<typeof boss.send>[2],
      );
      await db
        .update(outbox)
        .set({ forwardedAt: new Date() })
        .where(sql`${outbox.id} = ${row.id}`);
      forwarded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // last_attempt_at was set during the claim — only bump the
      // attempt counter and capture last_error here. The claim window
      // will release the row for retry once CLAIM_WINDOW_SECONDS elapses.
      await db
        .update(outbox)
        .set({
          forwarderAttempt: row.forwarder_attempt + 1,
          lastError: message,
        })
        .where(sql`${outbox.id} = ${row.id}`);
      logger.warn(
        {
          outboxId: row.id,
          queue: row.queue,
          attempt: row.forwarder_attempt + 1,
          err: message,
        },
        "outbox-forwarder: forward failed; row stays pending",
      );
    }
  }
  return forwarded;
}

/** Process-level mutex preventing two drain() calls from running
 *  concurrently within the same process. Belt to the atomic-claim
 *  suspender: even though atomic claim handles cross-process races
 *  correctly, the mutex avoids redundant intra-process SQL churn
 *  when NOTIFY + interval fire close together. */
let drainInFlight = false;
/** Reentry counter — if a drain wakeup arrives while the previous
 *  drain is in flight, set this so the running drain runs one extra
 *  pass after finishing (in case the new wakeup represents a row
 *  that landed after the running drain's SELECT). */
let drainReentryPending = false;

/** Drain pending rows until the queue is empty (or until the cap is
 *  hit) — invoked on LISTEN wakeup and on every periodic sweep. */
async function drain(boss: PgBoss): Promise<void> {
  if (drainInFlight) {
    drainReentryPending = true;
    return;
  }
  drainInFlight = true;
  try {
    do {
      drainReentryPending = false;
      let totalForwarded = 0;
      for (let i = 0; i < 10; i += 1) {
        const forwarded = await processOnce(boss);
        totalForwarded += forwarded;
        if (forwarded < BATCH_SIZE) break;
      }
      if (totalForwarded > 0) {
        logger.debug({ count: totalForwarded }, "outbox-forwarder: drained pending rows");
      }
    } while (drainReentryPending);
  } finally {
    drainInFlight = false;
  }
}

export interface StartOutboxForwarderOptions {
  /** Existing pg-boss instance from the worker's createBoss() call.
   *  Injected (rather than called via getBoss()) so the forwarder
   *  shares the worker's boss + pool instead of lazily booting a
   *  second singleton. */
  boss: PgBoss;
}

/** Start the long-running forwarder. Sets up:
 *    1. A dedicated pg.Client for LISTEN (LISTEN holds the connection;
 *       using a pooled client would prevent the pool from recycling it).
 *    2. A setInterval periodic sweep as durability backstop.
 *    3. Reconnect logic if the LISTEN client errors out.
 *
 *  Returns a teardown function the worker shutdown handler invokes. */
export async function startOutboxForwarder(
  opts: StartOutboxForwarderOptions,
): Promise<() => Promise<void>> {
  const { boss } = opts;
  let listenClient: pg.Client | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const connectListener = async (): Promise<void> => {
    if (stopped) return;
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    try {
      await client.connect();
      client.on("error", (err) => {
        logger.warn(
          { err: String(err.message) },
          "outbox-forwarder: LISTEN connection error; falling back to periodic sweep until reconnect",
        );
        if (listenClient === client) listenClient = null;
        // Reconnect after a beat — the sweep keeps draining in the meantime.
        setTimeout(() => {
          void connectListener();
        }, 5_000);
      });
      client.on("notification", () => {
        void drain(boss);
      });
      await client.query(`LISTEN "${NOTIFY_CHANNEL}"`);
      listenClient = client;
      logger.info({ channel: NOTIFY_CHANNEL }, "outbox-forwarder: LISTEN connection ready");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "outbox-forwarder: LISTEN connect failed; falling back to periodic sweep",
      );
      try {
        await client.end();
      } catch {
        // Ignore — connection was already dead.
      }
      setTimeout(() => {
        void connectListener();
      }, 5_000);
    }
  };

  await connectListener();
  // Initial drain in case rows landed before this worker booted.
  await drain(boss);

  sweepTimer = setInterval(() => {
    void drain(boss).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "outbox-forwarder: periodic sweep failed",
      );
    });
  }, SWEEP_INTERVAL_MS);

  return async () => {
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    if (listenClient) {
      try {
        await listenClient.query(`UNLISTEN "${NOTIFY_CHANNEL}"`);
        await listenClient.end();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "outbox-forwarder: shutdown unlisten/end failed",
        );
      }
    }
  };
}

/** Exposed for tests + the purge.daily cron that cleans forwarded rows. */
export async function deleteForwardedOutboxRows(olderThan: Date): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM outbox
    WHERE forwarded_at IS NOT NULL AND forwarded_at < ${olderThan.toISOString()}::timestamptz
    RETURNING id
  `);
  return result.rows.length;
}

/** Exposed for tests — bypasses the long-running loop and just processes
 *  one batch synchronously. Tests supply their own boss mock; production
 *  code uses startOutboxForwarder which threads the worker's boss
 *  through. */
export async function drainOutboxOnce(boss: PgBoss): Promise<void> {
  await drain(boss);
}

// Phase 03.0.3 follow-up (PR #31 Codex P2) — outbox forwarder.
//
// Long-running async loop in the worker process that translates pending
// `outbox` rows into pg-boss `boss.send` calls. Two wake-up sources:
//
//   1. Postgres LISTEN on 'outbox.new' channel — triggered by the
//      AFTER-INSERT trigger from migration 0029. Instant pickup
//      (typically <10ms after commit).
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
// Failure handling: every failed forward attempt bumps
// forwarder_attempt + stores last_error / last_attempt_at. After
// MAX_ATTEMPTS the row stays pending forever — operator must
// manually investigate via SELECT (or extend this with a dead-letter
// dispatch later).

import { sql } from "drizzle-orm";
import pg from "pg";
import { db, pool } from "../../lib/server/db/client.js";
import { outbox } from "../../lib/server/db/schema/outbox.js";
import { getBoss } from "../../lib/server/queue-client.js";
import { logger } from "../../lib/server/logger.js";
import { env } from "../../lib/server/config/env.js";

/** Forwarder LISTEN channel — must match `pg_notify('outbox.new', ...)`
 *  in migration 0029's AFTER-INSERT trigger. */
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

interface PendingRow {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  options: Record<string, unknown>;
  forwarder_attempt: number;
}

/** Process one batch of pending outbox rows. Returns the number of
 *  rows forwarded successfully so callers can decide whether to loop. */
async function processOnce(): Promise<number> {
  const result = await db.execute(sql`
    SELECT id, queue, payload, options, forwarder_attempt
    FROM outbox
    WHERE forwarded_at IS NULL AND forwarder_attempt < ${MAX_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `);
  const rows = result.rows as unknown as PendingRow[];
  if (rows.length === 0) return 0;

  const boss = await getBoss();
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
      await db
        .update(outbox)
        .set({
          forwarderAttempt: row.forwarder_attempt + 1,
          lastError: message,
          lastAttemptAt: new Date(),
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

/** Drain pending rows until the queue is empty (or until the cap is
 *  hit) — invoked on LISTEN wakeup and on every periodic sweep. */
async function drain(): Promise<void> {
  let totalForwarded = 0;
  for (let i = 0; i < 10; i += 1) {
    const forwarded = await processOnce();
    totalForwarded += forwarded;
    if (forwarded < BATCH_SIZE) break;
  }
  if (totalForwarded > 0) {
    logger.debug({ count: totalForwarded }, "outbox-forwarder: drained pending rows");
  }
}

/** Start the long-running forwarder. Sets up:
 *    1. A dedicated pg.Client for LISTEN (LISTEN holds the connection;
 *       using a pooled client would prevent the pool from recycling it).
 *    2. A setInterval periodic sweep as durability backstop.
 *    3. Reconnect logic if the LISTEN client errors out.
 *
 *  Returns a teardown function the worker shutdown handler invokes. */
export async function startOutboxForwarder(): Promise<() => Promise<void>> {
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
        void drain();
      });
      await client.query(`LISTEN "${NOTIFY_CHANNEL}"`);
      listenClient = client;
      logger.info(
        { channel: NOTIFY_CHANNEL },
        "outbox-forwarder: LISTEN connection ready",
      );
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
  await drain();

  sweepTimer = setInterval(() => {
    void drain().catch((err) => {
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
 *  one batch synchronously. */
export { drain as drainOutboxOnce };

// Keep the unused-import linter happy + ensure tree-shake protection for
// the `pool` re-export from db/client.js (the LISTEN client uses its own
// connection but other forwarder paths reuse the pool via Drizzle `db`).
void pool;

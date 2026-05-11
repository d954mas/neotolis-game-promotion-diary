// Phase 03.0.3 follow-up (PR #31 Codex P2) — transactional outbox helper.
//
// Public surface — one function that callers use INSIDE a Drizzle
// transaction to atomically commit a queue-intent alongside their DB
// changes. The forwarder (src/worker/handlers/outbox-forwarder.ts)
// translates outbox rows into pg-boss `boss.send` calls asynchronously.
//
// Use when:
//   - You have a DB UPDATE/INSERT that MUST be visible to the worker
//     BEFORE the worker starts (e.g. backfillTargetSince widening +
//     force-deep job — the worker's fan-out reads the new
//     backfillTargetSince).
//   - You want at-least-once delivery semantics with crash safety
//     (boss.send failure + retry without losing user intent).
//
// Don't use when:
//   - The job is purely scheduler-driven (cron tick) with no prior
//     request UPDATE — `boss.send` directly is fine and avoids the
//     0-200ms forwarder pickup latency.
//   - The job payload is fully self-contained (worker reads only
//     job.data, no DB lookup against just-updated rows) — direct
//     `boss.send` after the awaited UPDATE is fine because the UPDATE
//     commits before the await resolves.
//
// SOURCE-REFERENCE.md §12 has the full decision guide.

import { sql } from "drizzle-orm";
import { outbox } from "../db/schema/outbox.js";
import type { Tx } from "../db/client.js";

export interface OutboxEnqueueOptions {
  /** pg-boss singletonKey — set this to dedupe duplicate forwards on
   *  retry. The forwarder is at-least-once: if it crashes between
   *  boss.send success and updating forwarded_at, the next sweep will
   *  resend. A singletonKey makes the second send a no-op at the
   *  pg-boss layer. */
  singletonKey?: string;
  /** pg-boss singletonSeconds — coalescing window. */
  singletonSeconds?: number;
  /** pg-boss priority — higher runs first when the worker has multiple
   *  jobs in the queue. */
  priority?: number;
}

/**
 * Insert a queue-intent row into the outbox table. Must be called with
 * a transaction handle (`tx`) so the insert commits atomically with
 * other DB changes in the same transaction.
 *
 * The forwarder picks up the row via Postgres LISTEN/NOTIFY (instant in
 * normal conditions) or its 30s fallback sweep. After successful
 * `boss.send`, the forwarder sets `forwarded_at` and the cleanup
 * cron deletes rows older than 7 days from that mark.
 *
 * Returns nothing — the row id is auto-generated and not needed by
 * callers (the forwarder owns the lifecycle).
 */
export async function enqueueViaOutbox(
  tx: Tx,
  queue: string,
  payload: Record<string, unknown>,
  options: OutboxEnqueueOptions = {},
): Promise<void> {
  await tx
    .insert(outbox)
    .values({
      queue,
      payload,
      options: options as Record<string, unknown>,
    })
    .execute();
}

/**
 * Operator visibility helper — list outbox rows that have failed at
 * least one forward attempt. Useful for /admin/quota-style debugging
 * (Phase 6+) or ad-hoc SQL (`SELECT * FROM outbox WHERE
 * forwarder_attempt > 0 ORDER BY last_attempt_at DESC`).
 *
 * Returns the raw rows; callers project as needed. Limited to 100 by
 * default to keep the response bounded.
 */
export async function listStuckOutboxRows(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  limit = 100,
): Promise<unknown[]> {
  const result = await db.execute(sql`
    SELECT id, queue, forwarder_attempt, last_error, last_attempt_at, created_at
    FROM outbox
    WHERE forwarded_at IS NULL AND forwarder_attempt > 0
    ORDER BY last_attempt_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return result.rows;
}

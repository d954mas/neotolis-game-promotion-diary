// Reddit service-sources enqueue cron handler (D-RDT-CRON-BURST).
//
// Schedule: 0/6/12/18 UTC daily — 4 ticks per day.
//
// What this does: SCANS data_sources for every reddit_account /
// reddit_subreddit row with auto_import=true AND deleted_at IS NULL, then
// INSERTS one row per source into reddit_refresh_queue with:
//   - queue_name = 'service_source'
//   - type       = 'author_poll' (reddit_account) | 'sub_poll' (reddit_subreddit)
//   - payload    = { handle: <username> } | { sub: <subreddit> }
//   - user_id    = NULL (cron-driven; user-driven entries set user_id —
//                  V13 distinguishes the lanes by user_id IS NULL vs NOT
//                  NULL for cap-exemption purposes).
//   - priority   = 0
//
// The 8-tick worker (plan 05A) drains the queue at 8 rows/min effective
// ceiling; this cron just fills the queue.
//
// ZERO Reddit HTTP — pure DB enqueue per D-RDT-CRON-BURST.
//
// Cross-tenant by design: the SELECT walks all users' sources to enqueue
// one service-pool job per source. Per-source tenant identity is preserved
// inside the worker handler when it fans out events INSERTs.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { redditRefreshQueue } from "../schema/index.js";
import { logger } from "$lib/server/logger.js";

interface RedditSourceMetadata {
  username?: string;
  subreddit?: string;
}

export async function handleEnqueueServiceSourcesCron(): Promise<{ enqueued: number }> {
  // Cross-tenant SELECT — scheduler fan-out. The reddit-source set is
  // the full set of registered reddit_account + reddit_subreddit rows.
  // Each yields one queue row processed under the operator's worker
  // budget; the per-source fan-out to subscribers happens inside the
  // worker handlers (sub_poll, author_poll).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out: cron picks across tenants by design
  const sources = await db
    .select({
      id: dataSources.id,
      kind: dataSources.kind,
      metadata: dataSources.metadata,
      channelId: dataSources.channelId,
    })
    .from(dataSources)
    .where(
      and(
        sql`${dataSources.kind} IN ('reddit_account', 'reddit_subreddit')`,
        eq(dataSources.autoImport, true),
        isNull(dataSources.deletedAt),
      ),
    );

  if (sources.length === 0) {
    logger.info({ kind: "reddit" }, "reddit.enqueue_service_sources_cron: no sources to enqueue");
    return { enqueued: 0 };
  }

  // Build one queue row per source. Drop rows whose metadata is missing
  // the expected handle field — those are seed-data bugs, not runtime
  // failures, and surface as a WARN log + skipped row.
  const values: Array<typeof redditRefreshQueue.$inferInsert> = [];
  for (const s of sources) {
    const meta = (s.metadata ?? {}) as RedditSourceMetadata;
    if (s.kind === "reddit_account") {
      const handle = meta.username ?? s.channelId ?? null;
      if (handle === null) {
        logger.warn(
          { sourceId: s.id, kind: s.kind },
          "reddit.enqueue_service_sources_cron: reddit_account missing username; skipping",
        );
        continue;
      }
      values.push({
        queueName: "service_source",
        type: "author_poll",
        payload: { handle },
        userId: null,
        priority: 0,
      });
    } else if (s.kind === "reddit_subreddit") {
      const sub = meta.subreddit ?? s.channelId ?? null;
      if (sub === null) {
        logger.warn(
          { sourceId: s.id, kind: s.kind },
          "reddit.enqueue_service_sources_cron: reddit_subreddit missing subreddit; skipping",
        );
        continue;
      }
      values.push({
        queueName: "service_source",
        type: "sub_poll",
        payload: { sub },
        userId: null,
        priority: 0,
      });
    }
  }

  if (values.length === 0) {
    return { enqueued: 0 };
  }

  // Dedup via atomic INSERT … SELECT … WHERE NOT EXISTS — no read-then-
  // insert race window (a second cron instance, or a user-driven
  // backfill, cannot slip a duplicate in between our snapshot and our
  // bulk INSERT). Single statement; ~milliseconds for hundreds of rows.
  // Each candidate's existence-check is keyed on (queue_name, type,
  // payload identifier); identifier comes from payload->>'handle' for
  // author_poll and payload->>'sub' for sub_poll.
  //
  // Under singleton-cron + batchSize=1 the previous read-then-insert
  // pattern was also safe in practice, but the atomic form is the
  // correct shape — one place to reason about, no implicit invariant
  // about cron parallelism.
  const insertedRows = await atomicallyInsertNonDuplicates(values);
  const skipped = values.length - insertedRows;
  if (insertedRows === 0) {
    logger.info(
      { skipped },
      "reddit.enqueue_service_sources_cron: all candidates already pending; tick is a no-op",
    );
    return { enqueued: 0 };
  }
  logger.info(
    {
      enqueued: insertedRows,
      skipped,
      sourcesScanned: sources.length,
    },
    "reddit.enqueue_service_sources_cron: tick complete",
  );
  return { enqueued: insertedRows };
}

/** Atomically INSERT each candidate row only when no pending/processing
 *  row already exists for the same (queue_name, type, identifier).
 *  Returns the count of rows actually inserted. Single round-trip per
 *  candidate using `WHERE NOT EXISTS` — Postgres rolls back duplicates
 *  inside the same transaction window without surfacing them as errors.
 *
 *  We loop one INSERT per row instead of one VALUES (...) statement
 *  because the per-row WHERE NOT EXISTS subquery is row-specific
 *  (identifier differs). Drizzle's bulk insert API doesn't expose
 *  per-row WHERE, and raw SQL with a UNION/VALUES set would lose the
 *  Drizzle type-safety on the column list. At cron's scale (200 sources
 *  × 4 ticks/day) the loop is in the noise. */
async function atomicallyInsertNonDuplicates(
  candidates: Array<typeof redditRefreshQueue.$inferInsert>,
): Promise<number> {
  let inserted = 0;
  for (const row of candidates) {
    const payload = row.payload as { handle?: string; sub?: string };
    const isAuthor = row.type === "author_poll";
    const identifier = isAuthor ? payload.handle : payload.sub;
    if (identifier === undefined) continue; // already-warned upstream
    const payloadKey = isAuthor ? "handle" : "sub";
    const result = await db.execute<{ id: number }>(sql`
      INSERT INTO reddit_refresh_queue
        (queue_name, type, payload, user_id, priority)
      SELECT ${row.queueName}, ${row.type}, ${JSON.stringify(row.payload)}::jsonb, ${row.userId ?? null}, ${row.priority ?? 0}
      WHERE NOT EXISTS (
        SELECT 1 FROM reddit_refresh_queue
        WHERE queue_name = ${row.queueName}
          AND type = ${row.type}
          AND payload->>${payloadKey} = ${identifier}
          AND status IN ('pending', 'processing')
      )
      RETURNING id
    `);
    const queryRows = (result as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
    if (queryRows.length > 0) inserted++;
  }
  return inserted;
}

// Reddit service-posts enqueue cron handler (D-RDT-CRON-BURST).
//
// Schedule: 03/09/15/21 UTC daily — 4 ticks per day, staggered against
// service-sources cron (00/06/12/18 UTC) so the queue is mostly drained
// between the two enqueue waves.
//
// What this does: SCANS reddit_posts via the D-RDT-POST-ELIGIBILITY
// query — picks posts that need a fresh snapshot:
//
//   1. Young posts (<24h since submit) where last_snapshot_at is stale
//      (>6h old) OR never polled (NULL).
//   2. Old posts (>=24h since submit) where no snapshot exists at the
//      ~24h-after-submit mark (baseline backfill — these snapshots feed
//      the baselines cron's PERCENTILE_CONT aggregate).
//
//   AND deletion_detected_at IS NULL (dead posts are never re-polled).
//
// The eligible set is chunked into batches of MAX_BATCH=100 (Reddit's
// /api/info hard limit on id-list length) and one queue row is INSERTed
// per chunk with:
//   - queue_name = 'service_post'
//   - type       = 'post_batch'
//   - payload    = { post_ids: [...up to 100...] }
//   - user_id    = NULL (cron-driven; user_post lane is for user-driven).
//
// ZERO Reddit HTTP — pure DB scan + INSERT per D-RDT-CRON-BURST.
//
// LIMIT 500 caps the per-tick work: at 100 ids per batch that's at most
// 5 queue rows per tick, which at 8 ticks/min worker drain = ~38s of
// worker time per cron tick. Over a full day's 4 ticks that's 2000
// snapshots/day across the whole cache — sized to fit a small VPS
// indie-scale workload.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditRefreshQueue } from "../schema/index.js";
import { logger } from "$lib/server/logger.js";

/** Max post_ids per queue row — matches Reddit's /api/info hard limit
 *  (RESEARCH §Probe 4). The post_batch handler enforces this limit on
 *  read; we enforce it on write to keep payloads predictable. */
const MAX_BATCH = 100;

/** Per-tick LIMIT on eligible posts — bounds the worker drain time per
 *  cron tick. See header for the napkin math. */
const PICK_LIMIT = 500;

export async function handleEnqueueServicePostsCron(): Promise<{
  enqueued: number;
  batches: number;
}> {
  // D-RDT-POST-ELIGIBILITY query (CONTEXT.md lines 87-103). Verbatim
  // SQL — written as a raw `sql` literal because the OR + NOT EXISTS
  // shape is awkward to express in Drizzle's query builder.
  //
  // Outer parens around the (young OR old) disjunction are LOAD-BEARING:
  // without them the `AND deletion_detected_at IS NULL` clause binds
  // only to the second branch (SQL AND > OR precedence), so young dead
  // posts would still be picked. Tested in
  // tests/integration/reddit-cron-handlers.test.ts.
  const result = await db.execute(sql`
    SELECT post_id FROM reddit_posts
    WHERE
      (
        (
          (NOW() - submitted_at) < INTERVAL '24 hours'
          AND (last_snapshot_at IS NULL OR last_snapshot_at < NOW() - INTERVAL '6 hours')
        )
        OR
        (
          (NOW() - submitted_at) >= INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM reddit_post_snapshots s
            WHERE s.post_id = reddit_posts.post_id
              AND s.polled_at >= reddit_posts.submitted_at + INTERVAL '24 hours'
          )
        )
      )
      AND deletion_detected_at IS NULL
    ORDER BY submitted_at DESC
    LIMIT ${sql.raw(String(PICK_LIMIT))}
  `);

  const rows = (result as unknown as { rows: Array<{ post_id: string }> }).rows;
  if (rows.length === 0) {
    logger.info({}, "reddit.enqueue_service_posts_cron: no eligible posts");
    return { enqueued: 0, batches: 0 };
  }

  // Chunk into batches of MAX_BATCH.
  const postIds = rows.map((r) => r.post_id);
  const chunks: string[][] = [];
  for (let i = 0; i < postIds.length; i += MAX_BATCH) {
    chunks.push(postIds.slice(i, i + MAX_BATCH));
  }

  const values: Array<typeof redditRefreshQueue.$inferInsert> = chunks.map((ids) => ({
    queueName: "service_post",
    type: "post_batch",
    payload: { post_ids: ids },
    userId: null,
    priority: 0,
  }));

  await db.insert(redditRefreshQueue).values(values);
  logger.info(
    { enqueued: postIds.length, batches: chunks.length },
    "reddit.enqueue_service_posts_cron: tick complete",
  );
  return { enqueued: postIds.length, batches: chunks.length };
}

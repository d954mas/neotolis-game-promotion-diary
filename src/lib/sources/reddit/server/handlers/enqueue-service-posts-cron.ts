// Reddit service-posts enqueue cron handler.
//
// Schedule: 03/09/15/21 UTC daily — 4 ticks per day, staggered against
// the service-sources cron (00/06/12/18 UTC) so the queue mostly drains
// between waves.
//
// SCANS reddit_posts for rows that need a fresh snapshot:
//
//   1. Young posts (<24h since submit) where last_snapshot_at is stale
//      (>6h old) OR never polled.
//   2. Old posts (>=24h since submit) where no snapshot exists at the
//      ~24h-after-submit mark (baseline backfill — these snapshots feed
//      the baselines cron's PERCENTILE_CONT aggregate).
//   AND deletion_detected_at IS NULL (dead posts are never re-polled).
//
// Per-row enqueue (YouTube-shaped storage): each eligible post becomes
// ONE queue row.
//   - queue_name = 'service_post'
//   - type       = 'post_single'
//   - payload    = { post_id: 't3_<base36>' }
//   - user_id    = NULL  (cron lane; user_post is for user-driven work)
//
// Claim-time batching: the worker tick claims up to 100 rows on the
// service_post lane (per-lane `maxBatchSize: 100`) and dispatches them
// to ONE `/api/info?id=t3_a,t3_b,...` call. Same throughput as the
// pre-refactor `post_batch` payload-bundle shape — just stored
// per-row so dedup is trivial.
//
// ZERO Reddit HTTP here — pure DB scan + INSERT. The 8-tick worker
// drains the resulting rows.
//
// LIMIT 500 caps per-tick work: 100 rows / claim × ~5 claims per tick.
// Across the full day's 4 ticks that's ~2000 snapshots — sized to fit
// a small VPS indie-scale workload.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";

/** Per-tick LIMIT on eligible posts — bounds the worker drain time per
 *  cron tick. See header for the napkin math. */
const PICK_LIMIT = 500;

export async function handleEnqueueServicePostsCron(): Promise<{
  enqueued: number;
}> {
  // Eligibility query — written as a raw `sql` literal because the
  // OR + NOT EXISTS shape is awkward to express in Drizzle's query
  // builder.
  //
  // Outer parens around the (young OR old) disjunction are LOAD-BEARING:
  // without them the `AND deletion_detected_at IS NULL` clause binds
  // only to the second branch (SQL AND > OR precedence), so young dead
  // posts would still be picked. Tested in
  // tests/integration/reddit-cron-handlers.test.ts.
  //
  // Pending-queue exclusion — ONE clean NOT EXISTS now that every
  // pending row has its own payload->>'post_id'. Pre-refactor we
  // needed two clauses: one for bundled `post_batch` payloads (using
  // `jsonb_array_elements_text` to unfold the array) and one for
  // per-row `post_single`. The unified per-row shape collapses both.
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
      AND NOT EXISTS (
        SELECT 1 FROM adapter_refresh_queue q
        WHERE q.adapter_kind = 'reddit_account'
          AND q.type = 'post_single'
          AND q.status IN ('pending', 'processing')
          AND q.payload->>'post_id' = reddit_posts.post_id
      )
    ORDER BY submitted_at DESC
    LIMIT ${sql.raw(String(PICK_LIMIT))}
  `);

  const rows = (result as unknown as { rows: Array<{ post_id: string }> }).rows;
  if (rows.length === 0) {
    logger.info({}, "reddit.enqueue_service_posts_cron: no eligible posts");
    return { enqueued: 0 };
  }

  const postIds = rows.map((r) => r.post_id);

  // One per-row INSERT via VALUES + sql.join — same shape as the
  // service-sources cron's atomicallyInsertNonDuplicates batch path.
  // Single statement, no per-row round-trip.
  const valuesList = postIds.map((id) => sql`(${id})`);
  await db.execute(sql`
    INSERT INTO adapter_refresh_queue
      (adapter_kind, queue_name, type, payload, user_id, priority)
    SELECT 'reddit_account', 'service_post', 'post_single',
           jsonb_build_object('post_id', c.post_id), NULL, 0
    FROM (VALUES ${sql.join(valuesList, sql`, `)}) AS c(post_id)
  `);

  logger.info({ enqueued: postIds.length }, "reddit.enqueue_service_posts_cron: tick complete");
  return { enqueued: postIds.length };
}

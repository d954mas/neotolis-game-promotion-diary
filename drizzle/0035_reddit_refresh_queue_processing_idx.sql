-- Partial index for the stale-processing recovery scan in
-- src/lib/sources/reddit/server/handlers/worker-tick.ts.
--
-- The recovery query is:
--   UPDATE reddit_refresh_queue
--   SET status = 'pending'
--   WHERE status = 'processing'
--     AND last_attempt_at < $stale_since
--
-- The existing partial index `idx_reddit_refresh_queue_pending` covers
-- only `status='pending'`, so the recovery scan falls back to a seq
-- scan as the queue grows (done/dead_letter rows accumulate ~7 days
-- between deletion-propagation cron sweeps).
--
-- This index is partial on `status='processing'` so it's tiny — at
-- steady state it holds AT MOST N rows where N is the worker
-- concurrency × in-flight HTTP duration (~1-2s). On a single-process
-- worker that's 0-1 rows. The recovery UPDATE walks the index, not
-- the table.

CREATE INDEX IF NOT EXISTS "idx_reddit_refresh_queue_processing_last_attempt"
  ON "reddit_refresh_queue" ("last_attempt_at")
  WHERE "status" = 'processing';

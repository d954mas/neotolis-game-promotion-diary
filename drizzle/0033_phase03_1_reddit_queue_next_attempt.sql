-- Phase 03.1 follow-up: per-row backoff on reddit_refresh_queue.
--
-- Before: a transient/rate-limited failure re-queued the row with
-- status='pending' but no scheduling hint. The worker's dequeue
-- (`ORDER BY priority, enqueued_at LIMIT 1 FOR UPDATE SKIP LOCKED`)
-- would re-claim the same row on the very next tick, immediately
-- bumping attempts again. 429/403 burned through MAX_ATTEMPTS=5 in
-- ~40 seconds, dead-lettering rows that should have backed off
-- per the Retry-After header.
--
-- After: `next_attempt_at` carries the earliest retry timestamp.
-- - On re-queue after transient failure, worker sets it to
--   NOW() + AdapterError.retryAfterMs (or NOW() on success path).
-- - Dequeue adds `AND next_attempt_at <= NOW()` to the WHERE clause.
-- - Default NOW() makes existing pending rows immediately eligible.
--
-- Index updated to include next_attempt_at in the partial-pending
-- index so the dequeue stays cheap.

ALTER TABLE "reddit_refresh_queue"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz NOT NULL DEFAULT NOW();
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_reddit_refresh_queue_pending";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_refresh_queue_pending"
  ON "reddit_refresh_queue" ("queue_name", "status", "priority", "next_attempt_at", "enqueued_at")
  WHERE "status" = 'pending';

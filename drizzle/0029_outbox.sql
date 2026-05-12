-- Phase 03.0.3 follow-up (PR #31 Codex P2) — transactional outbox.
--
-- Closes the dual-write race between `data_sources` UPDATE and the
-- force-deep `boss.send` enqueue. Any service that needs the queue
-- write to commit atomically with a DB UPDATE writes a row here
-- inside the same Drizzle transaction; a forwarder long-running in the
-- worker process picks up pending rows (via Postgres LISTEN/NOTIFY)
-- and forwards them to pg-boss.
--
-- Schema notes:
--   - CROSS-TENANT BY DESIGN. The outbox is a queue-intent table; the
--     payload carries tenant context (userId in the job data). The
--     forwarder does NOT introspect payloads — it just calls
--     boss.send(queue, payload, options). Tenant scope flows through
--     the downstream queue handler, not this table.
--   - `forwarded_at` is the durable "this row's intent reached pg-boss"
--     marker. Cleanup (purge.daily extension) deletes rows older than
--     7 days after forward.
--   - Index on (created_at) WHERE forwarded_at IS NULL keeps the
--     forwarder's pending-scan O(log N) regardless of total rows.
--
-- INSERT-only is NOT enforced at the trigger level (unlike audit_log)
-- because the forwarder needs to UPDATE forwarded_at + retry counters.
-- The audit-log structural lock is for tenant-relative pagination
-- safety; outbox has neither tenant scope nor user-facing pagination.

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue text NOT NULL,
  payload jsonb NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by forwarder after a successful boss.send. NULL means pending.
  forwarded_at timestamptz,
  -- Retry telemetry — every failed forward attempt bumps this. Operator
  -- visibility via SQL: SELECT * FROM outbox WHERE forwarder_attempt > 3
  -- ORDER BY last_attempt_at DESC.
  forwarder_attempt int NOT NULL DEFAULT 0,
  last_error text,
  last_attempt_at timestamptz
);--> statement-breakpoint

-- Partial index: scans only the pending tail. created_at ordering
-- gives the forwarder a stable FIFO without needing a separate priority
-- column.
CREATE INDEX outbox_pending_idx
  ON outbox (created_at)
  WHERE forwarded_at IS NULL;--> statement-breakpoint

-- AFTER INSERT trigger emits a NOTIFY so the forwarder picks up the new
-- row within ms instead of waiting for the periodic sweep. The channel
-- name 'outbox.new' is the contract — the forwarder LISTENs on it.
-- The trigger fires per-row (FOR EACH ROW) so a transaction inserting
-- multiple outbox rows generates one NOTIFY per row; pg deduplicates
-- identical NOTIFY payloads within a transaction so the forwarder
-- gets at most one wakeup per tx commit, not per row.
--
-- NOTIFY is "best-effort, fire-and-forget" at the protocol level — if
-- the forwarder LISTEN connection dropped, we miss the wakeup. The
-- forwarder's periodic sweep (default 30s) is the durability backstop.
CREATE FUNCTION outbox_notify() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('outbox.new', '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER outbox_notify_trigger
  AFTER INSERT ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION outbox_notify();

// reddit_refresh_queue — single-table work queue consumed by the
// Reddit batch-worker setInterval loop.
//
// Queue table — `user_id` is in the payload column (NULLable top-level
// `user_id` for service-cron entries; user-driven entries set it for
// cap counters + audit). ESLint allowlist marks this entry as
// "queue table, payload-scoped" (NOT public-data).
//
// THIS IS THE ONE EXCEPTION to the "no in-process queue tables, use
// pg-boss" pattern. D-RDT-OUTBOX justification: pg-boss is great for
// fire-and-forget jobs but its concurrency model fights the
// 8-tick-per-minute deterministic round-robin we need to stay inside
// Reddit's 10-req/min public-`.json` ceiling under multi-replica
// deploys. A simple `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` per
// tick is clearer and correctly preserves rate-limit invariants under
// multi-instance deploys; pg-boss queues do NOT provide this guarantee
// out of the box at our scale.
//
// Four queue lanes (`queue_name` CHECK constraint, per D-RDT-CACHE-
// FIELDS):
//   - service_source — daily sub_poll / author_poll cron picks
//   - service_post   — daily post-snapshot cron picks
//   - user_source    — user-initiated source-refresh-content clicks
//   - user_post      — user-initiated post-paste single fetches
//
// Four work types (`type` CHECK constraint):
//   - sub_poll       — fetch /r/X/new.json (+ opportunistic about.json)
//   - author_poll    — fetch /user/X/submitted.json
//   - post_single    — fetch /comments/<id>.json
//   - post_batch     — batch-fetch /api/info?id=t3_xxx,t3_yyy,... (≤100 ids)
//
// Four lifecycle states (`status` CHECK constraint):
//   - pending       — queued, waiting for a worker slot
//   - processing    — locked by a worker via FOR UPDATE SKIP LOCKED
//   - done          — worker completed successfully (kept ~7 days for
//                     audit, then truncated by deletion-propagation cron)
//   - dead_letter   — exhausted retries; operator-visible via SQL
//                     `WHERE status='dead_letter'`
//
// `priority` is signed SMALLINT, lower = higher priority. The pending
// partial index orders by (queue_name, status, priority, enqueued_at)
// so a worker tick's `SELECT ... WHERE status='pending' ORDER BY
// priority, enqueued_at LIMIT 1 FOR UPDATE SKIP LOCKED` is O(log N) on
// the index.

import {
  pgTable,
  text,
  timestamp,
  integer,
  smallint,
  bigserial,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "$lib/server/db/schema/auth.js";

export const redditRefreshQueue = pgTable(
  "reddit_refresh_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    queueName: text("queue_name").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    // ON DELETE CASCADE — when a user is purged, their queued entries
    // vanish with them. Queue rows are ephemeral by design; loss on
    // user-purge is the correct privacy posture (no orphan PII via
    // the user_id column). Service-cron entries set user_id = NULL.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    priority: smallint("priority").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
  },
  (t) => ({
    // Pending-only partial index — the only read pattern that matters
    // for the worker tick's FOR UPDATE SKIP LOCKED dequeue path. Order
    // matches the worker's ORDER BY for cheap index-only scan.
    pendingIdx: index("idx_reddit_refresh_queue_pending")
      .on(t.queueName, t.status, t.priority, t.enqueuedAt)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export type RedditRefreshQueueEntry = typeof redditRefreshQueue.$inferSelect;
export type NewRedditRefreshQueueEntry = typeof redditRefreshQueue.$inferInsert;

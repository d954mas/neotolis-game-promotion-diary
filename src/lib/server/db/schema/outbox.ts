// Phase 03.0.3 follow-up (PR #31 Codex P2) — transactional outbox table.
//
// CROSS-TENANT BY DESIGN. This is a queue-intent table: rows describe
// pg-boss jobs to be sent. Tenant context is inside `payload`; the
// forwarder does NOT introspect — it just calls boss.send(queue, payload,
// options). Tenant scope flows through the downstream queue handler.
// ESLint tenant-scope rule allowlists this table via the same header
// comment convention used by youtube_video_snapshots / youtube_videos.
//
// Writer pattern (idiomatic):
//   await db.transaction(async (tx) => {
//     await tx.update(dataSources).set(...).where(...);
//     await enqueueViaOutbox(tx, QUEUES.YOUTUBE_BACKFILL_CHANNEL, payload, opts);
//   });
//   // Single COMMIT — UPDATE and outbox row commit atomically. The
//   // forwarder picks up the row via LISTEN/NOTIFY (or 30s fallback
//   // sweep) and calls boss.send.
//
// Failure modes:
//   - boss.send fails: forwarder leaves the row pending, bumps
//     forwarder_attempt, logs last_error. Next tick (or NOTIFY)
//     retries. At-least-once delivery.
//   - Forwarder crashes between boss.send success and forwarded_at
//     update: next tick re-forwards. pg-boss singletonKey in options
//     dedups duplicate sends; downstream handlers must be idempotent
//     (events have UNIQUE (user_id, source_id, external_id); audit
//     writes are accepted as occasional dup).
//
// Cleanup: extended purge.daily cron deletes rows older than 7 days
// after successful forward.

import { pgTable, text, timestamp, jsonb, integer, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
    forwarderAttempt: integer("forwarder_attempt").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  },
  (t) => [
    // Mirrors the partial index in migration 0029 — Drizzle's pg dialect
    // doesn't have a first-class partial-index helper but does pass
    // arbitrary `where` clauses through; declared here so drizzle-kit's
    // diff stays clean against future schema changes.
    index("outbox_pending_idx").on(t.createdAt),
  ],
);

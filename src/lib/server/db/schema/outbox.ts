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
//     forwarder_attempt, logs last_error. Retry happens after the
//     CLAIM_WINDOW_SECONDS interval (60s in outbox-forwarder.ts) has
//     elapsed since last_attempt_at — concurrent claimers see the
//     bumped timestamp and skip the row until the window expires.
//     So a failed row retries roughly every 60s on the next sweep
//     or NOTIFY wakeup, NOT every tick. After MAX_ATTEMPTS (20) the
//     row stays pending until an operator manually intervenes.
//   - Forwarder crashes mid-send (last_attempt_at bumped but no
//     forwarded_at update and no logged failure): the row stays
//     claimed for CLAIM_WINDOW_SECONDS, then releases naturally.
//     Another forwarder (or the next sweep) picks it up. pg-boss
//     singletonKey in options dedups duplicate sends in the worst-
//     case race; downstream handlers must be idempotent (events
//     have UNIQUE (user_id, source_id, external_id); audit writes
//     are accepted as occasional dup).
//
// Cleanup: extended purge.daily cron deletes rows older than 7 days
// after successful forward.

import { pgTable, text, timestamp, jsonb, integer, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
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
    // Phase 03.0.3 round-5 (Codex P2) — partial index matching
    // migration 0029's `CREATE INDEX outbox_pending_idx ON outbox
    // (created_at) WHERE forwarded_at IS NULL`. Without the `.where`
    // chain the schema would diverge from the applied migration and
    // a future `drizzle-kit generate` could regenerate the index
    // without the partial clause — defeating the forwarder's
    // pending-scan optimisation (full index over every forwarded
    // row instead of the tight pending tail).
    index("outbox_pending_idx")
      .on(t.createdAt)
      .where(sql`forwarded_at IS NULL`),
  ],
);

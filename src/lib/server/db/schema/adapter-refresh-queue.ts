// adapter_refresh_queue -- shared SQL lane queue for source adapters.
//
// Adapters own lane names, work types, payload schemas, and dispatch logic.
// The platform owns the common lifecycle:
//   pending -> processing -> done | dead_letter
// plus priority ordering, retry attempts, stale-processing recovery, and
// user purge privacy through user_id ON DELETE CASCADE.
//
// Keep adapter_kind / queue_name / type as text rather than enums. Adding a
// source adapter should be code-only unless it needs new storage outside the
// generic queue.

import {
  pgTable,
  text,
  timestamp,
  integer,
  smallint,
  bigserial,
  check,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.js";

export const adapterRefreshQueue = pgTable(
  "adapter_refresh_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adapterKind: text("adapter_kind").notNull(),
    queueName: text("queue_name").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    priority: smallint("priority").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
  },
  (t) => ({
    statusCheck: check(
      "adapter_refresh_queue_status_check",
      sql`${t.status} IN ('pending', 'processing', 'done', 'dead_letter')`,
    ),
    pendingIdx: index("idx_adapter_refresh_queue_pending")
      .on(t.adapterKind, t.queueName, t.status, t.priority, t.nextAttemptAt, t.enqueuedAt)
      .where(sql`${t.status} = 'pending'`),
    processingLastAttemptIdx: index("idx_adapter_refresh_queue_processing_last_attempt")
      .on(t.adapterKind, t.status, t.lastAttemptAt)
      .where(sql`${t.status} = 'processing'`),
    userWindowIdx: index("idx_adapter_refresh_queue_user_window").on(
      t.adapterKind,
      t.userId,
      t.queueName,
      t.enqueuedAt,
    ),
  }),
);

export type AdapterRefreshQueueEntry = typeof adapterRefreshQueue.$inferSelect;
export type NewAdapterRefreshQueueEntry = typeof adapterRefreshQueue.$inferInsert;

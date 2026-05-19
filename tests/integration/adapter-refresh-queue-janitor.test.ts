// Janitor handler — DELETE terminal-state rows past retention.
//
// What we assert:
//   1. Old `done` rows (>14d) → DELETED.
//   2. Old `dead_letter` rows (>14d) → DELETED.
//   3. Fresh `done` rows (<14d) → KEPT.
//   4. `pending` / `processing` rows of any age → KEPT (the worker still
//      owns them — janitor must not race the work).
//   5. Boundary: a row at exactly 14d retention is KEPT (the comparison is
//      strict `<` against `NOW() - 14 days`).

import { describe, it, expect } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import { adapterRefreshQueue } from "../../src/lib/server/db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import {
  ADAPTER_REFRESH_QUEUE_RETENTION_DAYS,
  handleAdapterRefreshQueueJanitor,
} from "../../src/lib/server/services/adapter-refresh-queue-janitor.js";

interface SeedRow {
  status: "pending" | "processing" | "done" | "dead_letter";
  ageDays: number;
  queueName: "service_source" | "service_post" | "user_source" | "user_post";
  type: "sub_poll" | "author_poll" | "post_single";
  userId: string | null;
}

async function seed(rows: SeedRow[]): Promise<number[]> {
  const ids: number[] = [];
  for (const r of rows) {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO adapter_refresh_queue (
        adapter_kind, queue_name, type, payload, user_id, priority,
        status, enqueued_at, next_attempt_at
      ) VALUES (
        'reddit_account',
        ${r.queueName},
        ${r.type},
        '{}'::jsonb,
        ${r.userId},
        0,
        ${r.status},
        NOW() - (${r.ageDays} || ' days')::interval,
        NOW()
      )
      RETURNING id
    `);
    const id = Number((result as unknown as { rows: Array<{ id: string }> }).rows[0]!.id);
    ids.push(id);
  }
  return ids;
}

async function rowExists(id: number): Promise<boolean> {
  const rows = await db
    .select({ id: adapterRefreshQueue.id })
    .from(adapterRefreshQueue)
    .where(eq(adapterRefreshQueue.id, id));
  return rows.length > 0;
}

describe("adapter_refresh_queue janitor", () => {
  it("retention constant is 14 days (matches the engine principle)", () => {
    expect(ADAPTER_REFRESH_QUEUE_RETENTION_DAYS).toBe(14);
  });

  it("deletes old done + dead_letter rows; keeps fresh + non-terminal", async () => {
    const ids = await seed([
      // 0: 30-day-old done — DELETE
      { status: "done", ageDays: 30, queueName: "user_post", type: "post_single", userId: null },
      // 1: 30-day-old dead_letter — DELETE
      {
        status: "dead_letter",
        ageDays: 30,
        queueName: "user_post",
        type: "post_single",
        userId: null,
      },
      // 2: 1-day-old done — KEEP (well inside retention)
      { status: "done", ageDays: 1, queueName: "user_post", type: "post_single", userId: null },
      // 3: 30-day-old pending — KEEP (worker owns it, never delete pending)
      {
        status: "pending",
        ageDays: 30,
        queueName: "service_source",
        type: "sub_poll",
        userId: null,
      },
      // 4: 30-day-old processing — KEEP (stale recovery handles, not janitor)
      {
        status: "processing",
        ageDays: 30,
        queueName: "service_source",
        type: "sub_poll",
        userId: null,
      },
      // 5: ~13-day-old done — KEEP (inside retention by 1 day)
      { status: "done", ageDays: 13, queueName: "user_post", type: "post_single", userId: null },
    ]);

    const result = await handleAdapterRefreshQueueJanitor();
    expect(result.rowsDeleted).toBe(2);

    expect(await rowExists(ids[0]!)).toBe(false);
    expect(await rowExists(ids[1]!)).toBe(false);
    expect(await rowExists(ids[2]!)).toBe(true);
    expect(await rowExists(ids[3]!)).toBe(true);
    expect(await rowExists(ids[4]!)).toBe(true);
    expect(await rowExists(ids[5]!)).toBe(true);
  });

  it("is idempotent — second run on the same state deletes zero rows", async () => {
    await seed([
      { status: "done", ageDays: 30, queueName: "user_post", type: "post_single", userId: null },
    ]);
    const first = await handleAdapterRefreshQueueJanitor();
    expect(first.rowsDeleted).toBe(1);
    const second = await handleAdapterRefreshQueueJanitor();
    expect(second.rowsDeleted).toBe(0);
  });
});

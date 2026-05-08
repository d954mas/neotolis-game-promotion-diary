// Phase 3.0 Plan 09 — queue topology assertion.
//
// Phase 1 declared 4 poll queues + internal.healthcheck as a forward-compat
// scaffold. Phase 3.0 Plan 01 collapsed POLL_HOT → POLL_ACTIVE and dropped
// POLL_WARM; Plan 09 adds 2 new scheduler-tick queues (Pattern A — separate
// cron-tick queues to keep enqueue logic on the worker pool).
//
// pgboss persists queue declarations in pgboss.queue. This test pins the
// topology so a future executor cannot accidentally re-introduce hot/warm
// or drop a Phase 3.0 queue.
//
// Implementation note: createBoss() is called once via getBoss() singleton
// to declare every QUEUES.* entry. The assertions read pgboss.queue table
// directly — pgboss exposes getQueues() but that returns a richer shape
// than we need; raw SQL keeps the test minimal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../setup.js";
import { getBoss, resetBossSingletonForTesting } from "../../src/lib/server/queue-client.js";
import { QUEUES } from "../../src/lib/server/queues.js";

let boss: Awaited<ReturnType<typeof getBoss>>;

beforeAll(async () => {
  // Force a fresh boot so the queue declarations land against THIS test DB.
  resetBossSingletonForTesting();
  boss = await getBoss();
});

afterAll(async () => {
  // Clean up the singleton between test files so other suites get fresh state.
  try {
    await boss.stop({ wait: true, graceful: false, timeout: 5_000 });
  } catch {
    /* swallow stop errors — boss may already be stopping */
  }
  resetBossSingletonForTesting();
});

describe("queue topology (Plan 03.0-09)", () => {
  it("declares all Phase 3.0 queues — POLL_USER, POLL_COLD, POLL_ACTIVE, INTERNAL_HEALTHCHECK, PURGE_DAILY, YOUTUBE_QUOTA_RESET, YOUTUBE_CHANNEL_CONTEXT_BACKFILL, SCHEDULER_TICK_ACTIVE, SCHEDULER_TICK_COLD", async () => {
    const expected = [
      QUEUES.POLL_USER,
      QUEUES.POLL_COLD,
      QUEUES.INTERNAL_HEALTHCHECK,
      QUEUES.POLL_ACTIVE,
      QUEUES.PURGE_DAILY,
      QUEUES.YOUTUBE_QUOTA_RESET,
      QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL,
      QUEUES.SCHEDULER_TICK_ACTIVE,
      QUEUES.SCHEDULER_TICK_COLD,
    ];

    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name = ANY($1::text[])`,
      [expected],
    );
    const present = new Set(rows.map((r) => r.name));
    for (const name of expected) {
      expect(present.has(name)).toBe(true);
    }
  });

  it("retired POLL_HOT and POLL_WARM names are absent from pgboss.queue (DV-2 collapse — Plan 01 migration)", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name IN ('poll.hot', 'poll.warm')`,
    );
    expect(rows).toHaveLength(0);
  });
});

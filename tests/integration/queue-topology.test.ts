// Phase 03.0.1 Plan 07 — per-kind queue topology assertion.
//
// Phase 1 declared 4 poll queues + internal.healthcheck as a forward-compat
// scaffold. Phase 3.0 Plan 01 collapsed POLL_HOT → POLL_ACTIVE and dropped
// POLL_WARM. Plan 09 added 2 scheduler-tick queues. Phase 03.0.1 Plan 07
// renames the YouTube-poll queues to the per-kind topology and retires
// the scheduler-tick queues (collapsed into the youtube.poll.cron schedule
// via pg-boss v11+ key-based multiple-schedule-per-queue).
//
// pgboss persists queue declarations in pgboss.queue. This test pins the
// new topology so a future executor cannot accidentally re-introduce the
// retired names or drop a Plan 07 queue.
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
    await boss.stop({ graceful: false, timeout: 5_000 });
  } catch {
    /* swallow stop errors — boss may already be stopping */
  }
  resetBossSingletonForTesting();
});

describe("queue topology (Plan 03.0.1-07 per-kind rename)", () => {
  it("declares all queues — INTERNAL_HEALTHCHECK, PURGE_DAILY, YOUTUBE_POLL_CRON, YOUTUBE_POLL_USER, YOUTUBE_BACKFILL_CHANNEL, YOUTUBE_QUOTA_RESET, YOUTUBE_REHAB, YOUTUBE_CHANNEL_CONTEXT_BACKFILL", async () => {
    const expected = [
      QUEUES.INTERNAL_HEALTHCHECK,
      QUEUES.PURGE_DAILY,
      QUEUES.YOUTUBE_POLL_CRON,
      QUEUES.YOUTUBE_POLL_USER,
      QUEUES.YOUTUBE_BACKFILL_CHANNEL,
      QUEUES.YOUTUBE_QUOTA_RESET,
      QUEUES.YOUTUBE_REHAB,
      QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL,
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

  it("retired POLL_HOT and POLL_WARM names are absent (DV-2 collapse — Phase 03.0 Plan 01 migration)", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name IN ('poll.hot', 'poll.warm')`,
    );
    expect(rows).toHaveLength(0);
  });

  it("retired queue names (poll.active, poll.cold, poll.user, scheduler.tick.*, youtube.rehab_unavailable, youtube.backfill.user) are absent", async () => {
    // The Plan-07 forward-only migration (drizzle/0021_phase03_01_per_kind_queue_topology.sql)
    // DELETEs orphan rows for these names from pgboss.queue. After the
    // migration runs and the new code declares the per-kind names, the
    // legacy names should not be re-created (no code path references them).
    const retired = [
      "poll.active",
      "poll.cold",
      "poll.user",
      "scheduler.tick.active",
      "scheduler.tick.cold",
      "youtube.rehab_unavailable",
      // Phase 03.0.1 Wave 2 — channel-scoped polling replaces per-source.
      "youtube.backfill.user",
    ];
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name = ANY($1::text[])`,
      [retired],
    );
    expect(rows).toHaveLength(0);
  });
});

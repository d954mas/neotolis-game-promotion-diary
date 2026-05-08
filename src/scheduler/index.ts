// APP_ROLE=scheduler entrypoint.
//
// Phase 1 shipped a no-op stub registering only the internal.healthcheck
// schedule. Phase 3.0 Plan 09 promotes the scheduler to a thin cron-fire
// loop that registers FOUR additional schedules:
//
//   - youtube.poll.active  '0 */6 * * *'                — every 6 hours UTC
//   - youtube.poll.cold    '0 5 * * *'                  — 5 AM UTC daily
//   - youtube.quota_reset  '0 0 * * *' tz=America/Los_Angeles — midnight Pacific
//   - purge.daily          '0 4 * * *' tz=America/Los_Angeles — 4 AM Pacific
//
// Pitfall D: youtube.quota_reset and purge.daily MUST run in Pacific time —
// YouTube's quota reset is at midnight Pacific (not UTC), and the daily
// backup at 03:00 Pacific must precede the purge at 04:00 Pacific so
// soft-deleted accounts being hard-deleted are still in the night's backup.
// pg-boss schedule options.tz handles DST transitions.
//
// Plan 09 Pattern A: the active + cold poll cron schedules send empty
// jobs to scheduler.tick.{active,cold} queues; the WORKER process owns
// the consumers (src/worker/index.ts) which call enqueueActivePolls /
// enqueueColdPolls and dispatch real per-event jobs to POLL_ACTIVE /
// POLL_COLD. This split keeps the scheduler container thin (no DB-touching
// logic) and ensures the enqueue path runs on the worker pool.
//
// SIGTERM drain inherited from Phase 1 stopBoss + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

export async function startScheduler(): Promise<void> {
  const boss = await createBoss();
  scrubKekFromEnv();

  // Phase 1 — internal healthcheck schedule preserved.
  try {
    await boss.schedule(QUEUES.INTERNAL_HEALTHCHECK, "*/5 * * * *");
  } catch (err) {
    logger.error({ err }, "failed to register internal.healthcheck schedule");
    throw err;
  }

  // Phase 3.0 Plan 09 — register the 4 new cron schedules. boss.schedule
  // is idempotent (same name → update); safe on every scheduler boot.

  // youtube.poll.active — every 6 hours UTC default (operator can revisit
  // to a tz-aware schedule if needed). Sends empty {} to scheduler.tick.active;
  // the worker subscribes and dispatches per-event POLL_ACTIVE jobs.
  await boss.schedule(QUEUES.SCHEDULER_TICK_ACTIVE, "0 */6 * * *", {});

  // youtube.poll.cold — once per day at 5 AM UTC. Cold tier is the first
  // thing to give up on heavy days (throttle 'eighty' pauses it).
  await boss.schedule(QUEUES.SCHEDULER_TICK_COLD, "0 5 * * *", {});

  // youtube.quota_reset — midnight Pacific. YouTube's daily quota resets
  // at this boundary (Pitfall D). tz handles PDT/PST transitions.
  await boss.schedule(
    QUEUES.YOUTUBE_QUOTA_RESET,
    "0 0 * * *",
    {},
    {
      tz: "America/Los_Angeles",
    },
  );

  // purge.daily — 4 AM Pacific (after backup at 03:00 Pacific). Plan 05's
  // listPurgeEligibleUsers + purgeAccount cascade.
  await boss.schedule(
    QUEUES.PURGE_DAILY,
    "0 4 * * *",
    {},
    {
      tz: "America/Los_Angeles",
    },
  );

  // Phase 3.0 post-build refactor (2026-05-06) — weekly rehab tick at
  // Sunday 4 AM Pacific (after the daily purge). Polls up to 50
  // unavailable videos with poll_failure_count < 5 to detect privacy
  // unflip. See worker/handlers/rehab-unavailable.ts for the failure-
  // count cap rationale.
  await boss.schedule(
    QUEUES.YOUTUBE_REHAB_UNAVAILABLE,
    "0 4 * * 0",
    {},
    {
      tz: "America/Los_Angeles",
    },
  );

  logger.info(
    {
      schedules: [
        QUEUES.INTERNAL_HEALTHCHECK,
        QUEUES.SCHEDULER_TICK_ACTIVE,
        QUEUES.SCHEDULER_TICK_COLD,
        QUEUES.YOUTUBE_QUOTA_RESET,
        QUEUES.PURGE_DAILY,
        QUEUES.YOUTUBE_REHAB_UNAVAILABLE,
      ],
    },
    "scheduler registered Phase 3.0 cron schedules",
  );

  // D-15 smoke assertion #3 — exact string `scheduler ready` on stdout.
  logger.info({ role: "scheduler" }, "scheduler ready");
  console.log("scheduler ready");

  // D-22 graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "scheduler received shutdown signal");
    try {
      await stopBoss(boss);
    } catch (err) {
      logger.warn({ err }, "pg-boss stop failed");
    }
    try {
      await pool.end();
    } catch (err) {
      logger.warn({ err }, "pool.end failed");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  return new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}

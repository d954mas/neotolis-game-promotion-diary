// APP_ROLE=worker entrypoint.
//
// Phase 1 shipped a no-op stub subscribing only to internal.healthcheck.
// Phase 3.0 Plan 09 promotes the worker to subscribe to ALL Phase 3.0
// queues with the pg-boss v10 array-handler shape (Pitfall A + B):
//
//   await boss.work(name, {batchSize}, async (jobs) => {
//     for (const job of jobs) await handler(job);
//   });
//
// Six new queue subscriptions land here:
//   - POLL_ACTIVE                       (scheduler-driven)   batchSize=4
//   - POLL_COLD                         (scheduler-driven)   batchSize=1
//   - POLL_USER                         (route-driven)       batchSize=2
//   - YOUTUBE_CHANNEL_CONTEXT_BACKFILL  (paste-trigger)      batchSize=1
//   - YOUTUBE_QUOTA_RESET               (cron-driven)        batchSize=1
//   - PURGE_DAILY                       (cron-driven)        batchSize=1
//
// Plus two scheduler-tick subscriptions (Pattern A from plan 09):
//   - SCHEDULER_TICK_ACTIVE             → calls enqueueActivePolls()
//   - SCHEDULER_TICK_COLD               → calls enqueueColdPolls()
//
// The scheduler.tick.* handlers live in this worker process intentionally:
// pg-boss schedules send empty {} jobs to those queues; we want the
// enqueue logic to run on the worker (not the scheduler) so the scheduler
// stays a thin cron-fire loop and the worker carries all the DB-touching
// logic. Self-host parity preserved — worker container handles both
// "consume real jobs" and "tick-driven enqueue dispatch".
//
// Existing INTERNAL_HEALTHCHECK subscription preserved unchanged.
//
// SIGTERM drain inherited from Phase 1 stopBoss (60s graceful) + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

import { handlePollActive } from "./handlers/poll-active.js";
import { handlePollCold } from "./handlers/poll-cold.js";
import { handlePollUser } from "./handlers/poll-user.js";
import { handleChannelContextBackfill } from "./handlers/youtube-channel-context-backfill.js";
import { handleQuotaReset } from "./handlers/youtube-quota-reset.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";
import { enqueueActivePolls, enqueueColdPolls } from "../scheduler/enqueue.js";

export async function startWorker(): Promise<void> {
  const boss = await createBoss();
  // P2 KEK scrub: worker has no bundled second copy of env.ts (no SvelteKit
  // handler.js import), so it's safe to scrub immediately after createBoss
  // resolves. See env.ts header for the rationale.
  scrubKekFromEnv();

  // Phase 1 — preserved.
  await boss.work(QUEUES.INTERNAL_HEALTHCHECK, async (jobs) => {
    for (const job of jobs) {
      logger.debug(
        { jobId: job.id, queue: QUEUES.INTERNAL_HEALTHCHECK },
        "healthcheck job processed",
      );
    }
  });

  // Phase 3.0 Plan 09 — subscriptions for the 6 phase queues.
  // Pitfall A+B: pg-boss v10 array-handler shape (jobs is an array, not a
  // single job). Each handler iterates and awaits per-job sequentially.
  await boss.work(QUEUES.POLL_ACTIVE, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollActive(job as { id: string; data: { eventIds: string[] } });
    }
  });

  await boss.work(QUEUES.POLL_COLD, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollCold(job as { id: string; data: { eventIds: string[] } });
    }
  });

  await boss.work(QUEUES.POLL_USER, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollUser(job as { id: string; data: { eventId: string; userId: string } });
    }
  });

  await boss.work(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleChannelContextBackfill(
        job as {
          id: string;
          data: {
            userId: string;
            channelId?: string;
            handleUrl?: string;
            sourceId?: string;
            backfillWindow?: "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
          };
        },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleQuotaReset(job as { id: string; data: object });
    }
  });

  await boss.work(QUEUES.PURGE_DAILY, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handlePurgeDaily(job as { id: string; data: object });
    }
  });

  // Scheduler-tick subscriptions (Pattern A — plan 09 recommendation).
  // The scheduler boots the cron schedules; we boot the consumers. Each
  // tick triggers the corresponding enqueue function, which then sends
  // real per-event jobs to POLL_ACTIVE / POLL_COLD.
  await boss.work(QUEUES.SCHEDULER_TICK_ACTIVE, { batchSize: 1 }, async (jobs) => {
    for (const _job of jobs) {
      try {
        await enqueueActivePolls();
      } catch (err) {
        logger.error({ err }, "scheduler.tick.active: enqueueActivePolls threw");
      }
    }
  });
  await boss.work(QUEUES.SCHEDULER_TICK_COLD, { batchSize: 1 }, async (jobs) => {
    for (const _job of jobs) {
      try {
        await enqueueColdPolls();
      } catch (err) {
        logger.error({ err }, "scheduler.tick.cold: enqueueColdPolls threw");
      }
    }
  });

  // D-15 smoke assertion #2 — exact string `worker ready` on stdout.
  logger.info({ role: "worker" }, "worker ready");
  console.log("worker ready");

  // D-22 graceful shutdown — Phase 1 contract, preserved.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker received shutdown signal");
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

  // Worker idles forever — pg-boss owns the polling loop.
  return new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}

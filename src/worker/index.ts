// APP_ROLE=worker entrypoint.
//
// Phase 1 shipped a no-op stub subscribing only to internal.healthcheck.
// Phase 3.0 Plan 09 promoted the worker to subscribe to ALL Phase 3.0
// queues with the pg-boss v10 array-handler shape (Pitfall A + B):
//
//   await boss.work(name, {batchSize}, async (jobs) => {
//     for (const job of jobs) await handler(job);
//   });
//
// Phase 03.0.1 Plan 05 — adapter-driven queue registration.
//
// Each per-source adapter owns its own queues; bootstrap iterates the
// registry and calls `adapter.registerQueues(boss)`. Adding Reddit
// (Phase 03.1) is a single-line registry entry — no edit here.
//
// Cross-source / non-per-kind queues are subscribed directly in this
// file because they apply regardless of source kind:
//   - INTERNAL_HEALTHCHECK              (Phase 1)
//   - PURGE_DAILY                       (cross-tenant FK-cascade purge)
//   - SCHEDULER_TICK_ACTIVE / _COLD     (cron→enqueue dispatch — Pattern A)
//
// SIGTERM drain inherited from Phase 1 stopBoss (60s graceful) + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

import { allAdapters } from "../lib/sources/registry.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";
import { enqueueActivePolls, enqueueColdPolls } from "../scheduler/enqueue.js";

export async function startWorker(): Promise<void> {
  const boss = await createBoss();
  // P2 KEK scrub: worker has no bundled second copy of env.ts (no SvelteKit
  // handler.js import), so it's safe to scrub immediately after createBoss
  // resolves. See env.ts header for the rationale.
  scrubKekFromEnv();

  // Phase 1 — internal healthcheck (preserved).
  await boss.work(QUEUES.INTERNAL_HEALTHCHECK, async (jobs) => {
    for (const job of jobs) {
      logger.debug(
        { jobId: job.id, queue: QUEUES.INTERNAL_HEALTHCHECK },
        "healthcheck job processed",
      );
    }
  });

  // Phase 03.0.1 Plan 05 — per-source adapters register their own queues.
  // Each adapter calls boss.createQueue + boss.work for the queues it
  // owns; the worker process sees them all because we iterate the
  // registry. Order is registration order from registry.ts (currently
  // just youtube; Reddit / Twitter / Telegram / Discord queue here in
  // Phase 03.1+).
  for (const adapter of allAdapters) {
    await adapter.registerQueues(boss);
  }

  // Cross-source / non-per-kind queues — subscribed directly because
  // they apply regardless of source kind.
  await boss.createQueue(QUEUES.PURGE_DAILY);
  await boss.work(QUEUES.PURGE_DAILY, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handlePurgeDaily(job as { id: string; data: object });
    }
  });

  // Scheduler-tick subscriptions (Pattern A — Phase 3.0 Plan 09).
  // The scheduler boots the cron schedules; we boot the consumers. Each
  // tick triggers the corresponding enqueue function, which then sends
  // real per-event jobs to POLL_ACTIVE / POLL_COLD. These are
  // cross-source dispatch ticks (the enqueue functions themselves
  // resolve per-kind work via the tier resolver) so they live here, not
  // in any one adapter's registerQueues.
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

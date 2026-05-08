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
// Phase 03.0.1 Plan 05 — adapter-driven queue registration. Each per-source
// adapter owns its own queues; bootstrap iterates the registry and calls
// `adapter.registerQueues(boss)`. Adding Reddit (Phase 03.1) is a
// single-line registry entry — no edit here.
//
// Phase 03.0.1 Plan 07 — the two scheduler.tick.* subscriptions are
// RETIRED. Pre-Plan-07 (Pattern A from Phase 03.0 Plan 09) the cron sent
// empty {} jobs to scheduler.tick.{active,cold} queues that the worker
// drained by calling enqueueActivePolls / enqueueColdPolls (which then
// enqueued real per-event poll.active / poll.cold jobs). Plan 07 collapses
// that hop: the cron schedule sends tier-tagged jobs DIRECTLY to
// youtube.poll.cron, the poll-cron handler reads job.data.tier and
// dispatches inline. No more scheduler-tick → enqueue → real-job indirection.
//
// Cross-source / non-per-kind queues are subscribed directly in this file
// because they apply regardless of source kind:
//   - INTERNAL_HEALTHCHECK              (Phase 1)
//   - PURGE_DAILY                       (cross-tenant FK-cascade purge)
//
// SIGTERM drain inherited from Phase 1 stopBoss (60s graceful) + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

import { allAdapters } from "../lib/sources/registry.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";

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

  // Phase 03.0.1 Plan 07 — scheduler.tick.* subscriptions RETIRED.
  // The cron schedule (registered in src/scheduler/index.ts via each
  // adapter.scheduleCronTicks) now sends tier-tagged jobs directly to
  // youtube.poll.cron; the poll-cron handler dispatches by tier. The
  // intermediate scheduler-tick → enqueue → per-event-job hop is gone.

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

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
import { env, scrubKekFromEnv } from "../lib/server/config/env.js";

import { allAdapters } from "../lib/sources/registry.js";
import { reconcileReservoirsOnBoot } from "../lib/sources/youtube/server/http.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";

export async function startWorker(): Promise<void> {
  // Phase 03.0.1 architecture cleanup — multi-replica safety guard.
  // The YouTube adapter's chargedFetch reservoir uses RateLimiterMemory
  // (per-process state). With N>1 worker replicas each holds an
  // independent 8000-unit cron pool / 2000-unit user pool — daily quota
  // would be N × budget, burning the operator's YouTube envelope past
  // its 10000-unit daily cap and tripping 95% throttle prematurely.
  //
  // Today's compose runs 1 worker (no `replicas:` directive). Operators
  // who scale via WORKER_REPLICA_COUNT > 1 trip this assert at boot
  // INSTEAD of silently overshooting quota in production. Migrating
  // away from this constraint = swap RateLimiterMemory →
  // RateLimiterPostgres in src/lib/sources/youtube/server/http.ts
  // (same library, persistent shared backend) and remove this guard.
  if (env.WORKER_REPLICA_COUNT > 1) {
    throw new Error(
      `WORKER_REPLICA_COUNT=${env.WORKER_REPLICA_COUNT} but the YouTube reservoir is per-process. ` +
        `Migrate src/lib/sources/youtube/server/http.ts from RateLimiterMemory to RateLimiterPostgres ` +
        `before scaling worker replicas — otherwise the operator's YouTube quota burns N× the daily budget.`,
    );
  }

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

  // Phase 03.0.1 Plan 08 — reconcile in-memory rate-limit reservoirs to
  // the persistent youtube_service_quota_usage counter BEFORE adapters
  // register queues. RateLimiterMemory loses state across process
  // restarts; without reconciliation a worker that crashed at 7000 cron
  // units used would re-start with a fresh 8000-unit cron pool and
  // briefly over-allow until the persistent counter caught the next
  // throttle threshold. Best-effort — logs and continues on DB errors.
  try {
    await reconcileReservoirsOnBoot();
  } catch (err) {
    logger.warn({ err }, "youtube reservoirs: reconcileReservoirsOnBoot threw — continuing");
  }

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

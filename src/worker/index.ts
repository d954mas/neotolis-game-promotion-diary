// APP_ROLE=worker entrypoint.
//
// The worker subscribes to all queues using the pg-boss v10 array-handler shape:
//
//   await boss.work(name, {batchSize}, async (jobs) => {
//     for (const job of jobs) await handler(job);
//   });
//
// Adapter-driven queue registration. Each per-source adapter owns its own
// queues; bootstrap iterates the registry and calls
// `adapter.registerQueues(boss)`. Adding a new source kind is a single-line
// registry entry — no edit here.
//
// The cron schedule sends tier-tagged jobs DIRECTLY to youtube.poll.cron;
// the poll-cron handler reads job.data.tier and dispatches inline — no
// scheduler-tick → enqueue → real-job indirection.
//
// Cross-source / non-per-kind queues are subscribed directly in this file
// because they apply regardless of source kind:
//   - INTERNAL_HEALTHCHECK
//   - PURGE_DAILY                       (cross-tenant FK-cascade purge)
//
// SIGTERM drain via stopBoss (60s graceful) + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { env, scrubKekFromEnv } from "../lib/server/config/env.js";

import { allAdapters } from "../lib/sources/registry.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";
import { startOutboxForwarder } from "./handlers/outbox-forwarder.js";

export async function startWorker(): Promise<void> {
  // Multi-replica safety guard.
  //
  // Adapters that use in-process rate-limit state (e.g., RateLimiterMemory
  // reservoirs) declare it via observability.usesInProcessRateLimiter.
  // With N>1 worker replicas, each replica holds independent budgets →
  // N × envelope burn, quota overshoot in production. The assertion lists
  // every offending adapter so the operator knows which ones need migration
  // to a persistent backend (RateLimiterPostgres, DB-backed counter)
  // before scaling replicas.
  if (env.WORKER_REPLICA_COUNT > 1) {
    const offending = allAdapters
      .filter((a) => a.observability.usesInProcessRateLimiter === true)
      .map((a) => a.kind);
    if (offending.length > 0) {
      throw new Error(
        `WORKER_REPLICA_COUNT=${env.WORKER_REPLICA_COUNT} but the following adapter(s) ` +
          `use per-process rate-limit state: ${offending.join(", ")}. ` +
          `Migrate each adapter's reservoir to a persistent backend ` +
          `(RateLimiterPostgres or DB-backed counter) and flip ` +
          `observability.usesInProcessRateLimiter to false before scaling worker replicas — ` +
          `otherwise daily quota budgets burn N× the envelope.`,
      );
    }
  }

  const boss = await createBoss();
  // KEK scrub: worker has no bundled second copy of env.ts (no SvelteKit
  // handler.js import), so it's safe to scrub immediately after createBoss
  // resolves. See env.ts header for the rationale.
  scrubKekFromEnv();

  // Internal healthcheck.
  await boss.work(QUEUES.INTERNAL_HEALTHCHECK, async (jobs) => {
    for (const job of jobs) {
      logger.debug(
        { jobId: job.id, queue: QUEUES.INTERNAL_HEALTHCHECK },
        "healthcheck job processed",
      );
    }
  });

  // Adapter-owned runtime-state reconcile.
  // Each adapter that maintains in-process state (e.g., RateLimiterMemory
  // reservoirs that lose state on worker restart) declares
  // `reconcileRuntimeState` to sync against persistent counters BEFORE jobs
  // start dispatching. Adapters with only persistent state (DB-backed
  // counters, RateLimiterPostgres) omit the hook. Best-effort: errors are
  // logged-and-continued; a failed reconcile does NOT block worker boot.
  for (const adapter of allAdapters) {
    if (!adapter.reconcileRuntimeState) continue;
    try {
      await adapter.reconcileRuntimeState();
    } catch (err) {
      logger.warn(
        { err, adapter: adapter.kind },
        "adapter runtime-state reconcile threw — continuing",
      );
    }
  }

  // Per-source adapters register their own queues. Each adapter calls
  // boss.createQueue + boss.work for the queues it owns; the worker process
  // sees them all because we iterate the registry. Order is registration
  // order from registry.ts.
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

  // Transactional outbox forwarder. Long-running async loop that translates
  // pending outbox rows into pg-boss `boss.send` calls. Uses LISTEN on
  // 'outbox.new' for instant pickup + 30s periodic sweep as backstop.
  // Returns a teardown closure the shutdown handler awaits.
  const stopOutboxForwarder = await startOutboxForwarder({ boss });

  // Smoke assertion — exact string `worker ready` on stdout.
  logger.info({ role: "worker" }, "worker ready");
  console.log("worker ready");

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker received shutdown signal");
    try {
      await stopOutboxForwarder();
    } catch (err) {
      logger.warn({ err }, "outbox-forwarder stop failed");
    }
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

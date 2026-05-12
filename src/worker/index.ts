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
import { handlePurgeDaily } from "./handlers/purge-daily.js";
import { startOutboxForwarder } from "./handlers/outbox-forwarder.js";

export async function startWorker(): Promise<void> {
  // Phase 03.0.1 architecture cleanup — multi-replica safety guard.
  //
  // Adapters that use in-process rate-limit state (e.g., RateLimiterMemory
  // reservoirs) declare it via observability.usesInProcessRateLimiter.
  // With N>1 worker replicas, each replica holds independent budgets →
  // N × envelope burn, quota overshoot in production. The assertion lists
  // every offending adapter so the operator knows which ones need migration
  // to a persistent backend (RateLimiterPostgres, DB-backed counter)
  // before scaling replicas.
  //
  // Pre-Phase-03.0.1-post-review the assertion hardcoded YouTube; the
  // generic loop here surfaces every adapter that ships in-process state.
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

  // Phase 03.0.1 architecture cleanup — adapter-owned runtime-state reconcile.
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

  // Phase 03.0.3 follow-up (PR #31 Codex P2) — transactional outbox
  // forwarder. Long-running async loop that translates pending
  // outbox rows into pg-boss `boss.send` calls. Uses LISTEN on
  // 'outbox.new' for instant pickup + 30s periodic sweep as backstop.
  // Returns a teardown closure the shutdown handler awaits.
  const stopOutboxForwarder = await startOutboxForwarder({ boss });

  // D-15 smoke assertion #2 — exact string `worker ready` on stdout.
  logger.info({ role: "worker" }, "worker ready");
  console.log("worker ready");

  // D-22 graceful shutdown — Phase 1 contract, preserved.
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

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
// Adapter-owned workQueue loops run alongside pg-boss when dequeue
// order itself is part of the quota contract. Reddit uses this for its
// fixed 8-slot/min lane worker; future adapters can declare their own
// loops from the adapter instead of adding source-specific imports here.
//
// SIGTERM drain via stopBoss (60s graceful) + adapter interval cleanup + pool.end.

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { db, pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";
import { sql } from "drizzle-orm";

import { allAdapters } from "../lib/sources/registry.js";
import { handlePurgeDaily } from "./handlers/purge-daily.js";
import { handleAdapterRefreshQueueJanitor } from "../lib/server/services/adapter-refresh-queue-janitor.js";
import { startOutboxForwarder } from "./handlers/outbox-forwarder.js";
import type { PoolClient } from "pg";

export async function startWorker(): Promise<void> {
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

  // Adapter-owned bootstrap locks. Adapters that declare a singleton runtime
  // need one worker replica to own their pg-boss handlers and scheduled
  // workers. A session advisory lock lets unrelated adapters keep running
  // in parallel on the same deployment.
  const adapterRuntimeLocks: PoolClient[] = [];
  const activeAdapters: Array<(typeof allAdapters)[number]> = [];
  for (const adapter of allAdapters) {
    if (adapter.observability.requiresSingletonRuntime === true) {
      const lockClient = await tryAcquireAdapterRuntimeLock(adapter.kind);
      if (lockClient === null) {
        logger.info(
          { role: "worker", adapter: adapter.kind },
          "adapter runtime lock busy; skipping adapter queue registration on this replica",
        );
        continue;
      }
      adapterRuntimeLocks.push(lockClient);
    }
    activeAdapters.push(adapter);
  }

  // Adapter-owned runtime-state reconcile.
  // Adapters that still keep process-local runtime state can reconcile it
  // against persistent counters BEFORE jobs start dispatching. Adapters
  // with only persistent state omit the hook. Best-effort: errors are
  // logged-and-continued; a failed reconcile does NOT block worker boot.
  for (const adapter of activeAdapters) {
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
  for (const adapter of activeAdapters) {
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

  await boss.createQueue(QUEUES.ADAPTER_REFRESH_QUEUE_JANITOR);
  await boss.work(QUEUES.ADAPTER_REFRESH_QUEUE_JANITOR, { batchSize: 1 }, async (jobs) => {
    for (const _ of jobs) await handleAdapterRefreshQueueJanitor();
  });

  // Transactional outbox forwarder. Long-running async loop that translates
  // pending outbox rows into pg-boss `boss.send` calls. Uses LISTEN on
  // 'outbox.new' for instant pickup + 30s periodic sweep as backstop.
  // Returns a teardown closure the shutdown handler awaits.
  const stopOutboxForwarder = await startOutboxForwarder({ boss });

  // Adapter-owned scheduled workers. These are not pg-boss subscribers:
  // their tick cadence and dequeue order are part of the adapter's quota
  // policy. Smoke keeps reading the adapter-provided ready/disabled
  // messages, so Reddit's existing boot contract stays stable.
  const adapterWorkerIntervals: ReturnType<typeof setInterval>[] = [];
  for (const adapter of activeAdapters) {
    for (const worker of adapter.workQueue?.scheduledWorkers ?? []) {
      if (worker.isEnabled()) {
        let tickInFlight = false;
        const interval = setInterval(() => {
          if (tickInFlight) {
            logger.debug(
              { adapter: adapter.kind, worker: worker.name },
              "adapter scheduled worker tick skipped because prior tick is still running",
            );
            return;
          }
          tickInFlight = true;
          runAdapterScheduledTick(adapter.kind, worker)
            .catch((err) =>
              logger.warn(
                {
                  adapter: adapter.kind,
                  worker: worker.name,
                  err: String((err as Error)?.message ?? err),
                },
                "adapter scheduled worker tick threw - continuing",
              ),
            )
            .finally(() => {
              tickInFlight = false;
            });
        }, worker.intervalMs);
        adapterWorkerIntervals.push(interval);
        logger.info(
          { role: "worker", adapter: adapter.kind, worker: worker.name },
          worker.readyMessage,
        );
        console.log(worker.readyMessage);
      } else {
        logger.info(
          { role: "worker", adapter: adapter.kind, worker: worker.name },
          worker.disabledMessage,
        );
        console.log(worker.disabledMessage);
      }
    }
  }

  // Smoke assertion — exact string `worker ready` on stdout.
  logger.info({ role: "worker" }, "worker ready");
  console.log("worker ready");

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker received shutdown signal");
    // Clear adapter worker intervals FIRST so no new ticks start after
    // shutdown begins. In-flight ticks complete naturally —
    // the SQL tx inside tryClaimAndDispatch either commits or rolls
    // back; FOR UPDATE SKIP LOCKED ensures the row's status reflects
    // the final outcome.
    while (adapterWorkerIntervals.length > 0) {
      const interval = adapterWorkerIntervals.pop();
      if (interval !== undefined) {
        clearInterval(interval);
      }
    }
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
    for (const client of adapterRuntimeLocks.splice(0)) {
      client.release();
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

async function tryAcquireAdapterRuntimeLock(adapterKind: string): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const lockKey = `adapter-runtime:${adapterKind}`;
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey],
    );
    if (result.rows[0]?.locked === true) {
      logger.info(
        { role: "worker", adapter: adapterKind },
        "adapter runtime lock acquired on this replica",
      );
      return client;
    }
    client.release();
    return null;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function runAdapterScheduledTick(
  adapterKind: string,
  worker: {
    name: string;
    replicaPolicy: "singleton" | "parallel";
    tick(): Promise<unknown>;
  },
): Promise<void> {
  if (worker.replicaPolicy === "parallel") {
    await worker.tick();
    return;
  }

  await db.transaction(async (tx) => {
    const lockKey = `adapter-worker:${worker.name}`;
    const result = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
    `);
    const locked =
      (result as unknown as { rows?: Array<{ locked: boolean }> }).rows?.[0]?.locked === true;
    if (!locked) {
      logger.debug(
        { adapter: adapterKind, worker: worker.name },
        "adapter scheduled worker singleton lock busy; skipping tick on this replica",
      );
      return;
    }
    await worker.tick();
  });
}

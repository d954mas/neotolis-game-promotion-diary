// APP_ROLE=scheduler entrypoint. REPLACES the Plan 06 stub at this same path.
//
// D-01 locks `src/scheduler/index.ts` as the canonical scheduler module
// location. Plan 06 shipped a no-op stub at this same path; this plan
// promotes it to a real pg-boss-backed scheduler that prints
// `scheduler ready` (the literal string Plan 10's smoke test greps for —
// D-15 assertion #3).
//
// Phase 1 has NO real cron schedules. Phase 3 lands the adaptive polling
// cron expressions (POLL-01..06). What we MUST get right today:
//   - boot pg-boss with the locked 10.x API
//   - declare every queue (Phase-1 pitfall mitigation; same as worker)
//   - register at least ONE schedule so the cron loop is proven alive —
//     `internal.healthcheck` every 5 minutes is the marker
//   - print `scheduler ready` to stdout for Plan 10's grep-based assertion
//   - honor SIGTERM with pg-boss graceful drain + pg.Pool drain (D-22)

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

/**
 * Boot the pg-boss scheduler, declare queues, register the healthcheck cron,
 * and idle until SIGTERM. The export name `startScheduler` matches what
 * `src/server.ts` imports — the Plan 06 stub had the same export so the
 * dispatcher does not need to be touched.
 */
export async function startScheduler(): Promise<void> {
  const boss = await createBoss();
  // P2 KEK scrub: same as worker — scheduler has no bundled second copy of
  // env.ts, so it's safe to scrub immediately. See env.ts header.
  scrubKekFromEnv();

  // pg-boss 10.x `schedule(queueName, cronExpression, data?, options?)`
  // registers a recurring enqueue against the named queue. The schedule
  // entry is persistent — pg-boss survives restart and resumes scheduling
  // from the schedules table.
  //
  // Phase 1 ships ONE schedule: `internal.healthcheck` every 5 minutes.
  // It proves the scheduler loop is alive and exercises the same code path
  // Phase 3 will use for poll cron expressions. If the cron syntax or the
  // queue name is invalid, schedule() throws — we log loudly and re-throw
  // so the container exits non-zero (faster failure than a silent never-
  // scheduled cron).
  try {
    await boss.schedule(QUEUES.INTERNAL_HEALTHCHECK, "*/5 * * * *");
  } catch (err) {
    logger.error({ err }, "failed to register internal.healthcheck schedule");
    throw err;
  }

  // D-15 smoke assertion #3 — exact string `scheduler ready` on stdout.
  // Mirror the worker's dual emission: structured log for production
  // observability, raw console.log for Plan 10's grep contract.
  logger.info({ role: "scheduler" }, "scheduler ready");
  console.log("scheduler ready");

  // D-22 graceful shutdown. Same shape as the worker — drain pg-boss first
  // (which stops emitting new scheduled enqueues), then drain the pg.Pool.
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

  // Scheduler idles forever — pg-boss owns the cron loop. Block on a
  // never-resolving promise so the Node process stays alive until SIGTERM.
  return new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}

// APP_ROLE=worker entrypoint. REPLACES the Plan 06 stub at this same path.
//
// D-01 locks `src/worker/index.ts` as the canonical worker module location.
// Plan 06 shipped a no-op stub at this same path; this plan promotes it to a
// real pg-boss-backed worker that prints `worker ready` (the literal string
// Plan 10's smoke test greps for — D-15 assertion #2).
//
// Phase 1 has NO real job handlers. Phase 3 (POLL-01..06) lands the
// poll.{hot,warm,cold,user} handlers. What we MUST get right today:
//   - boot pg-boss with the locked 10.x API
//   - declare every queue so the topology is locked from Phase 1
//     (Open Question Q1 / Phase-1-specific pitfall mitigation)
//   - subscribe to at least ONE queue (`internal.healthcheck`) so the worker
//     is alive and connected — a worker that boots but has no subscriptions
//     is effectively a silent idle that hides bugs
//   - print `worker ready` to stdout for Plan 10's grep-based assertion
//   - honor SIGTERM with pg-boss graceful drain + pg.Pool drain (D-22)

import { createBoss, stopBoss } from "../lib/server/queue-client.js";
import { pool } from "../lib/server/db/client.js";
import { logger } from "../lib/server/logger.js";
import { QUEUES } from "../lib/server/queues.js";
import { scrubKekFromEnv } from "../lib/server/config/env.js";

/**
 * Boot the pg-boss worker, declare queues, subscribe to internal.healthcheck,
 * and idle until SIGTERM. The export name `startWorker` matches what
 * `src/server.ts` imports — the Plan 06 stub had the same export so the
 * dispatcher does not need to be touched.
 */
export async function startWorker(): Promise<void> {
  const boss = await createBoss();
  // P2 KEK scrub: worker has no bundled second copy of env.ts (no SvelteKit
  // handler.js import), so it's safe to scrub immediately after createBoss
  // resolves. See env.ts header for the rationale.
  scrubKekFromEnv();

  // Phase 1 no-op handler on `internal.healthcheck`. Phase 3 replaces with
  // real work + adds `poll.*` subscriptions.
  //
  // pg-boss 10.x `work(name, handler)` invokes the handler with an array of
  // jobs (batch size = 1 by default). Acknowledgement is implicit: the
  // promise resolves successfully → job is marked complete; throw → job is
  // retried per the queue's retry policy (Phase 3 defines retry policy).
  await boss.work(QUEUES.INTERNAL_HEALTHCHECK, async (jobs) => {
    for (const job of jobs) {
      logger.debug(
        { jobId: job.id, queue: QUEUES.INTERNAL_HEALTHCHECK },
        "healthcheck job processed",
      );
    }
  });

  // D-15 smoke assertion #2 — exact string `worker ready` on stdout.
  // We emit BOTH a structured log line (Loki / docker logs JSON) AND a
  // raw console.log line. Plan 10's smoke test greps for `worker ready`
  // and does not parse JSON; the raw line is the grep target. The
  // structured line preserves observability for production deploys.
  logger.info({ role: "worker" }, "worker ready");
  console.log("worker ready");

  // D-22 graceful shutdown. SIGTERM/SIGINT drain pg-boss first (so in-flight
  // handlers complete), THEN pool.end() (so any handler that took a Drizzle
  // connection releases cleanly). Either drain failure logs and continues —
  // we still want process.exit(0) so the orchestrator sees a clean stop.
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

  // Worker idles forever — pg-boss owns the polling loop. Block on a
  // never-resolving promise so the Node process stays alive until SIGTERM.
  return new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}

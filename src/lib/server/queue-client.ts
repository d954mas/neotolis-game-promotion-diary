// pg-boss client factory shared by the worker and scheduler role entrypoints.
//
// CLAUDE.md locks pg-boss at 10.1.10 for Phase 1 (RESEARCH.md drift table —
// 12.x is current upstream; we are explicitly NOT chasing that for the MVP).
//
// pg-boss 10.x API notes (cross-checked against RESEARCH.md):
//   - We pass `connectionString` and let pg-boss manage its own internal pool.
//     Sharing a `pg.Pool` with Drizzle is supported in newer versions but is
//     fragile in 10.x and the explicit reason RESEARCH.md gave for "pg-boss on
//     its own pool" — keeps queue traffic from contending with app/audit traffic
//     for connections.
//   - `createQueue(name)` is idempotent and MUST be called for every queue
//     before send/work in v10+ (this is the v9→v10 breaking change). The
//     Phase-1-specific pitfall mitigation: declare every queue from
//     `src/lib/server/queues.ts` on every boot via `declareAllQueues(boss)`.
//   - `boss.stop({ wait, graceful, timeout })` is the documented graceful
//     drain in 10.x — completes in-flight handlers up to the timeout, then
//     hard-stops. We pair it with `pool.end()` in the role entrypoints so
//     both pg-boss' own pool AND Drizzle's app pool drain on SIGTERM.

import PgBoss from "pg-boss";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { declareAllQueues } from "./queues.js";

/**
 * Create + start a pg-boss instance with all Phase 1 queues declared.
 *
 * Conservative defaults; Phase 3 (POLL-01..06) will tune `max`, retention,
 * and per-queue concurrency once real polling workloads exist.
 *
 *   - max: 4              → small pool; pg-boss internal connections only
 *   - retentionDays: 30   → keep job history a month for incident debugging
 *   - archiveCompletedAfterSeconds: 3600 → archive completed jobs hourly so
 *                            the active jobs table stays small
 *
 * Open Question Q1 (RESEARCH.md, MEDIUM confidence) is implemented here:
 * declare all four poll queues + `internal.healthcheck` from Phase 1 even
 * though Phase 1 runs no jobs. That locks the topology so Phase 3's worker
 * lands without re-litigating queue boundaries.
 */
export async function createBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    max: 4,
    retentionDays: 30,
    archiveCompletedAfterSeconds: 3600,
    // pg-boss creates its own schema (default: 'pgboss') and runs its
    // internal migrations on .start(). Distinct from app migrations
    // (Plan 03's runMigrations()), which target the public schema.
  });

  boss.on("error", (err) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();

  // Phase-1 specific pitfall mitigation: always declare every queue at boot.
  // createQueue is idempotent in v10+, so calling on every boot is safe and
  // also prevents queue-declaration drift between deploys.
  await declareAllQueues(boss);

  return boss;
}

/**
 * Graceful drain. Wait up to 60 s for in-flight jobs (D-22 graceful shutdown
 * in CONTEXT.md; surfaces Phase 3's POLL-06 requirement that no in-flight
 * poll is lost on redeploy).
 *
 * pg-boss 10.x API: `stop({ wait, graceful, timeout })`.
 *   - wait: true     → resolve only after the boss is fully stopped
 *   - graceful: true → completes in-flight job handlers
 *   - timeout: 60_000 → hard-stop ceiling so a wedged handler cannot hang the
 *                       container indefinitely; orchestrators (Docker, k8s)
 *                       expect SIGTERM→exit within their own grace period.
 */
export async function stopBoss(boss: PgBoss): Promise<void> {
  logger.info("pg-boss draining");
  await boss.stop({ wait: true, graceful: true, timeout: 60_000 });
  logger.info("pg-boss stopped");
}

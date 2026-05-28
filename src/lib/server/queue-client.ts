// pg-boss client factory shared by the worker and scheduler role entrypoints.
//
// pg-boss is pinned at 12.x (load-bearing dep, dedicated PR per AGENTS.md
// "Locked stack versions"). v12 is ESM-native — note the named import below.
//
// pg-boss 12.x API notes:
//   - We pass `connectionString` and let pg-boss manage its own internal pool.
//     Sharing a `pg.Pool` with Drizzle is supported but we keep them separate
//     so queue traffic does not contend with app/audit traffic for connections.
//   - `createQueue(name)` is idempotent and MUST be called for every queue
//     before send/work (v10+ requirement, unchanged in 12.x). Mitigation:
//     declare every queue from `src/lib/server/queues.ts` on every boot via
//     `declareAllQueues(boss)`.
//   - `boss.stop({ wait, graceful, timeout })` is the documented graceful
//     drain — completes in-flight handlers up to the timeout, then hard-stops.
//     We pair it with `pool.end()` in role entrypoints so both pg-boss' own
//     pool AND Drizzle's app pool drain on SIGTERM.
//   - v11 removed archive tables (`archiveCompletedAfterSeconds` is gone);
//     completed jobs stay in the job table until `deleteAfterSeconds` (default
//     7 days) elapses. v11 also unified time options under `*Seconds` —
//     `retentionDays` / `retentionHours` / `retentionMinutes` are gone.
//   - v12 dropped the default export — `import { PgBoss } from "pg-boss"`.

import { PgBoss } from "pg-boss";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { declareAllQueues } from "./queues.js";

// Postgres SQLSTATEs for "the connection was terminated by the server", which
// is exactly what happens to pg-boss's pool on every deploy/restart when the
// container gets SIGTERM and Postgres closes the backend. These are lifecycle
// events, not application bugs — logging them at `error` (level 50) floods the
// Grafana error panel on every single deploy. Downgrade to `warn`; a genuine
// pg-boss fault (any other code) still logs at error.
//   57P01 admin_shutdown      — "terminating connection due to administrator command"
//   57P03 cannot_connect_now  — server still starting up / shutting down
const PG_CONNECTION_LIFECYCLE_CODES = new Set(["57P01", "57P03"]);

export function logPgBossError(err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && PG_CONNECTION_LIFECYCLE_CODES.has(code)) {
    logger.warn({ err, code }, "pg-boss connection terminated (shutdown/restart)");
    return;
  }
  logger.error({ err }, "pg-boss error");
}

/**
 * Create + start a pg-boss instance with all queues declared.
 *
 *   - max: 4                    → small pool; pg-boss internal connections only
 *   - retentionSeconds: 2_592_000 → keep job history 30 days for incident debugging
 *
 * v12 default `deleteAfterSeconds` (7 days) governs when completed jobs are
 * removed from the job table — leaving it implicit unless a queue needs
 * different retention.
 *
 * All queue names live in `src/lib/server/queues.ts` and are declared at boot
 * via `declareAllQueues(boss)` (createQueue is idempotent in v10+).
 */
export async function createBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    max: 4,
    // pg-boss creates its own schema (default: 'pgboss') and runs its
    // internal migrations on .start(). Distinct from app migrations
    // (runMigrations()), which target the public schema.
    //
    // Retention is per-queue in v12 (`QueueOptions.retentionSeconds`).
    // We rely on v12's defaults: 14d retention for queued/retry jobs,
    // 7d delete-after-completed. Tune per-queue in queues.ts if a
    // specific queue needs different behaviour.
  });

  boss.on("error", logPgBossError);

  await boss.start();

  // Always declare every queue at boot. createQueue is idempotent in
  // v10+, so calling on every boot is safe and also prevents
  // queue-declaration drift between deploys.
  await declareAllQueues(boss);

  return boss;
}

/**
 * Graceful drain. Wait up to 60 s for in-flight jobs so no in-flight
 * poll is lost on redeploy.
 *
 *   - graceful: true → completes in-flight job handlers
 *   - timeout: 60_000 → hard-stop ceiling so a wedged handler cannot hang the
 *                       container indefinitely; orchestrators (Docker, k8s)
 *                       expect SIGTERM→exit within their own grace period.
 *
 * v12 removed the `wait` option from StopOptions — `boss.stop()` now always
 * resolves only after the boss is fully stopped (the previous `wait: true`
 * behaviour is the only behaviour). `close` defaults to true and tears down
 * pg-boss's internal pool.
 */
export async function stopBoss(boss: PgBoss): Promise<void> {
  logger.info("pg-boss draining");
  await boss.stop({ graceful: true, timeout: 60_000 });
  logger.info("pg-boss stopped");
}

// Process-wide boss singleton for the APP role.
//
// Worker / scheduler entrypoints own their own boss instance via
// createBoss (and call stopBoss at SIGTERM). The APP role is different:
// HTTP handlers occasionally need to enqueue jobs (refresh-poll,
// account-purge-now), but each request booting its own boss would burn
// one Postgres connection per request and throw on graceful shutdown
// when no one calls stopBoss.
//
// `getBoss()` lazily boots ONE boss per process, memoizes the promise, and
// returns the same instance on every subsequent call. The first call pays
// the boss startup cost; subsequent calls resolve synchronously from the
// memoized promise.
//
// Lifecycle: the singleton lives until process exit. A future
// process-exit hook is the only place that should call
// `stopBossSingleton()`; the unwinding-at-exit path is acceptable for
// now because pg-boss's own pool drains on Node's process exit.
let bossSingleton: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossSingleton === null) {
    bossSingleton = createBoss();
  }
  return bossSingleton;
}

/**
 * Reset the memoized singleton. Test-only helper — production code never
 * calls this. Vitest test files reset between test cases so a fresh boss
 * is booted (or the same one is reused) on demand.
 */
export function resetBossSingletonForTesting(): void {
  bossSingleton = null;
}

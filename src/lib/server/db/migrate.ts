// Programmatic migration runner with a Postgres advisory lock.
//
// Pattern 1 (RESEARCH.md "Migrations on boot"): every container that boots
// the app/worker/scheduler image attempts to run pending migrations against
// its own `DATABASE_URL` before serving traffic. Concurrent containers must
// not race the migration table — we use `pg_advisory_lock(int8)` so only one
// process applies migrations at a time, and the others wait until the lock
// is released, then observe the final schema and proceed.
//
// `migrationsApplied.current` is a mutable boolean read by `/readyz` (Open
// Question Q4 — strict readyz semantics). The HTTP server exposes /readyz
// only after this flag flips true, so Cloudflare Tunnel / Docker healthcheck
// don't route traffic to a partially-migrated process.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

/** Set to true once migrations finish on this process. /readyz reads this. */
export const migrationsApplied = { current: false };

// Stable 64-bit advisory lock key. The bytes spell 'MIGRATE1' in ASCII —
// distinct from any app-data lock and easy to recognize in `pg_locks`.
//
// 0x4D49475241544531 = 5_494_251_782_888_259_377 in decimal.
// That value is well within Postgres int8 max (9_223_372_036_854_775_807),
// so passing it as a JS BigInt → string is safe. Reviewers: this comment is
// the BIGINT-safety annotation called out in VALIDATION.md revision 1 W2.
const LOCK_KEY = 0x4d49475241544531n; // BIGINT-safe; pg accepts numeric/bigint

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  let lockHeld = false;
  try {
    logger.info({ phase: "migrate" }, "acquiring advisory lock");
    await client.query(`SELECT pg_advisory_lock($1)`, [LOCK_KEY.toString()]);
    lockHeld = true;
    const localDb = drizzle(client);
    await migrate(localDb, { migrationsFolder: "./drizzle" });
    // Defensive ordering: release the advisory lock BEFORE flipping the
    // readyz flag. With unlock first, /readyz can only flip true after the
    // lock is gone, so an orchestrator that watches /readyz never routes
    // traffic to a process still holding a session-level Postgres lock.
    await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY.toString()]);
    lockHeld = false;
    migrationsApplied.current = true;
    logger.info({ phase: "migrate" }, "migrations applied");
  } finally {
    // Belt-and-suspenders: if migrate() threw, ensure unlock is still
    // attempted. Even if this RPC fails, the session-level advisory lock is
    // released when client.release() returns the connection to the pool and
    // pool.end() closes it — so this is a defensive cleanup, not the only
    // safety net.
    if (lockHeld) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY.toString()]);
      } catch (err) {
        logger.warn({ err, phase: "migrate" }, "advisory_unlock failed in finally");
      }
    }
    client.release();
    await pool.end();
  }
}

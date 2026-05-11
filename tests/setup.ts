import { afterEach, beforeAll } from "vitest";
import pg from "pg";

// Vitest setup file imported by the `integration` project (see vitest.config.ts).
//
// Reads TEST_DATABASE_URL (NOT DATABASE_URL — keep prod and test DBs distinct, see CLAUDE.md
// "Open-source compatibility"), opens a pg.Pool, runs migrations once at suite start, and
// truncates every public table between specs.
//
// Plan 01-03 has landed `src/lib/server/db/migrate.ts`; if migrations fail (e.g. no Postgres
// reachable), the catch logs a warn so contributors understand why integration tests
// skip-with-context.
//
// Phase 03.0.3 UAT follow-up — env-routing fix. Pre-fix the truncate pool
// used TEST_DATABASE_URL while the Drizzle `db` client in
// src/lib/server/db/client.ts read DATABASE_URL. On a developer machine
// where DATABASE_URL points to the local production-data database, every
// integration test wrote fixtures (`view=1/like=0/comment=0`, mocked
// `vid_*` external_ids) into prod data and the afterEach TRUNCATE bit
// the wrong DB. Force the Drizzle client to share the same DB as this
// setup file by overwriting DATABASE_URL BEFORE any test imports
// transitively pull in $lib/server/config/env.ts (which Zod-validates the
// value at module-load time). vitest setupFiles run before test files,
// so this assignment is in scope for every test process.
const dbUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/neotolis_test";
process.env.DATABASE_URL = dbUrl;

export const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });

beforeAll(async () => {
  try {
    const { runMigrations } = await import("../src/lib/server/db/migrate.js");
    await runMigrations();
  } catch (err) {
    console.warn("[tests/setup] migrations failed:", (err as Error).message);
  }
});

afterEach(async () => {
  // Truncate every public table — order-insensitive via TRUNCATE ... CASCADE.
  // Skip pg_catalog and pg_toast.
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    if (rows.length === 0) return;
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  } catch {
    // Pre-migration: nothing to truncate. Swallow — integration tests will skip-with-context.
  }
});

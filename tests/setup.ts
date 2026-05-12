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
  // Phase 03.0.3 round-3 (Codex P2) — migration failure is no longer
  // silently warned. Pre-fix this try/catch suppressed both "no Postgres
  // reachable" (the original intent) AND "schema drift on local
  // neotolis_test DB" (an accidental side effect). Integration tests
  // against a half-migrated DB are vacuous-pass at best and silently
  // wrong at worst; AGENTS.md Validation §4 ("CI gate honesty") forbids
  // both shapes. We now propagate the failure so:
  //   - CI sees a clean migration on every run (fresh DB → no drift
  //     ever surfaces), or fails the integration-tests job loudly.
  //   - Local dev sees the drift immediately and can resolve it via
  //     `docker exec <pg-container> psql -U postgres -c 'DROP DATABASE
  //     neotolis_test;' && pnpm db:migrate` (recreate via the migrate
  //     helper that runs against TEST_DATABASE_URL).
  // The "no Postgres" case still surfaces with a clear ECONNREFUSED that
  // any contributor recognises.
  const { runMigrations } = await import("../src/lib/server/db/migrate.js");
  await runMigrations();
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

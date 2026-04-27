import { afterEach, beforeAll } from 'vitest';
import pg from 'pg';

// Vitest setup file imported by the `integration` project (see vitest.config.ts).
//
// Reads TEST_DATABASE_URL (NOT DATABASE_URL — keep prod and test DBs distinct, see CLAUDE.md
// "Open-source compatibility"), opens a pg.Pool, runs migrations once at suite start, and
// truncates every public table between specs.
//
// The migration runner does not exist yet — Plan 01-03 lands `src/lib/server/db/migrate.ts`.
// Until then, the dynamic import below throws and we print a warn so contributors understand
// why integration tests skip-with-context. Once Plan 03 lands, the warn disappears.
const dbUrl =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/neotolis_test';

export const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });

beforeAll(async () => {
  try {
    // @ts-expect-error — module lands in Plan 01-03; until then this throws and we warn.
    const { runMigrations } = await import('../src/lib/server/db/migrate.js');
    await runMigrations();
  } catch (err) {
    // Plan 03 lands runMigrations; until then, integration tests will skip-with-context.
    // eslint-disable-next-line no-console
    console.warn(
      '[tests/setup] migrations not yet wired (Plan 01-03):',
      (err as Error).message,
    );
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
    const names = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  } catch {
    // Pre-migration: nothing to truncate. Swallow — integration tests will skip-with-context.
  }
});

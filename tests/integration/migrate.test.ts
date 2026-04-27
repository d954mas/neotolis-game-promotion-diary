import { describe, it, expect } from 'vitest';
import pg from 'pg';
import {
  runMigrations,
  migrationsApplied,
} from '../../src/lib/server/db/migrate.js';

// VALIDATION 14 + 15 (Plan 01-03):
//   14. migrations idempotent on second boot
//   15. advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)
//
// Both tests run against the integration Postgres service container that
// tests/setup.ts boots. TEST_DATABASE_URL is the same connection string the
// global setup uses; we open a small read-only pool here only to assert the
// final schema shape.

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/neotolis_test';

describe('migrations', () => {
  it('idempotent on second boot (re-running migrate() is a no-op)', async () => {
    // First call (may have already run via tests/setup.ts beforeAll, but
    // runMigrations is idempotent — second invocation must complete cleanly).
    await runMigrations();
    expect(migrationsApplied.current).toBe(true);

    // Re-run; should not throw and must leave schema intact.
    await runMigrations();

    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const { rows } = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const names = rows.map((r) => r.tablename);
      expect(names).toContain('user');
      expect(names).toContain('session');
      expect(names).toContain('account');
      expect(names).toContain('verification');
      expect(names).toContain('audit_log');
    } finally {
      await pool.end();
    }
  });

  it('advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)', async () => {
    // Spawn two concurrent runMigrations calls. The advisory lock means one
    // waits while the other runs migrate(); both must resolve without error
    // and the final schema must be consistent.
    await Promise.all([runMigrations(), runMigrations()]);
    expect(migrationsApplied.current).toBe(true);

    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const { rows } = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public'`,
      );
      const names = rows.map((r) => r.tablename);
      // Schema is consistent (no half-applied state from a race).
      expect(names).toContain('user');
      expect(names).toContain('audit_log');
    } finally {
      await pool.end();
    }
  });
});

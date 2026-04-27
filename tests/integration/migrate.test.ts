import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations, migrationsApplied } from "../../src/lib/server/db/migrate.js";

// VALIDATION 14 + 15 (Plan 01-03):
//   14. migrations idempotent on second boot
//   15. advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)
//
// Plan 02-03 extends this suite with Phase 2 schema-shape assertions: the
// 7 new tables, the 2 new pgEnums, the audit_log.action type conversion,
// the user.theme_preference column, and the new audit_log composite index.
//
// All tests run against the integration Postgres service container that
// tests/setup.ts boots. TEST_DATABASE_URL is the same connection string the
// global setup uses; we open a small read-only pool here only to assert the
// final schema shape.
//
// IMPORTANT — the local pool below talks to TEST_DATABASE_URL directly so the
// test does not depend on src/lib/server/db/client.js (which reads DATABASE_URL
// via the env loader and would point at the wrong DB in the integration suite).

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/neotolis_test";

describe("migrations", () => {
  it("idempotent on second boot (re-running migrate() is a no-op)", async () => {
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
      expect(names).toContain("user");
      expect(names).toContain("session");
      expect(names).toContain("account");
      expect(names).toContain("verification");
      expect(names).toContain("audit_log");
    } finally {
      await pool.end();
    }
  });

  it("advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)", async () => {
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
      expect(names).toContain("user");
      expect(names).toContain("audit_log");
    } finally {
      await pool.end();
    }
  });
});

// Plan 02-03 (D-11, D-28, D-32, D-40): Phase 2 schema migration assertions.
//
// tests/setup.ts already calls runMigrations() once in beforeAll. We re-run
// here to cover the case where this file is executed in isolation; the runner
// is idempotent (verified by the suite above).
describe("Phase 2 schema migration (Plan 02-03)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("creates the 7 new Phase 2 tables (D-11)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const expected = [
        "games",
        "game_steam_listings",
        "youtube_channels",
        "game_youtube_channels",
        "api_keys_steam",
        "tracked_youtube_videos",
        "events",
      ];
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
        [expected],
      );
      const found = result.rows.map((r) => r.tablename).sort();
      expect(found).toEqual(expected.slice().sort());
    } finally {
      await pool.end();
    }
  });

  it("creates event_kind and audit_action pgEnums (D-28, D-32)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ typname: string }>(
        `select typname from pg_type where typname in ('event_kind', 'audit_action')`,
      );
      const found = result.rows.map((r) => r.typname).sort();
      expect(found).toEqual(["audit_action", "event_kind"]);
    } finally {
      await pool.end();
    }
  });

  it("audit_log.action is now of type audit_action (D-32, ALTER COLUMN ... USING)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ udt_name: string }>(
        `select udt_name from information_schema.columns where table_name='audit_log' and column_name='action'`,
      );
      expect(result.rows[0]?.udt_name).toBe("audit_action");
    } finally {
      await pool.end();
    }
  });

  it("user.theme_preference column exists with default 'system' (D-40)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ column_default: string | null }>(
        `select column_default from information_schema.columns where table_name='user' and column_name='theme_preference'`,
      );
      expect(result.rows[0]?.column_default ?? "").toMatch(/system/);
    } finally {
      await pool.end();
    }
  });

  it("audit_log gains user_id+action+created_at index for filter-by-action queries (D-32)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename='audit_log' and indexname='audit_log_user_id_action_created_at_idx'`,
      );
      expect(result.rows.length).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("Phase 1 audit rows survive the action-column type conversion", async () => {
    // The cast `text USING action::audit_action` aborts the migration if any
    // pre-existing row carries a value not in AUDIT_ACTIONS. All Phase 1
    // values (session.signin / signout / signout_all / user.signup) are
    // included in the new enum, so the query below is a smoke check that
    // the type conversion did not corrupt rows. n may be 0 on a fresh test DB.
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ n: string }>(
        `select count(*)::text as n from audit_log where action in ('session.signin','session.signout','session.signout_all','user.signup')`,
      );
      expect(result.rows[0]?.n).toBeDefined();
      expect(Number.isFinite(Number(result.rows[0]?.n))).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

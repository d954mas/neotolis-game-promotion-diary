import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations, migrationsApplied } from "../../src/lib/server/db/migrate.js";

// VALIDATION 14 + 15 (Plan 01-03):
//   14. migrations idempotent on second boot
//   15. advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)
//
// Plan 02.1-01 collapses the prior Phase 1 + Phase 2 migrations into one new
// baseline (`0000_phase02_1_baseline.sql`) per CONTEXT D-03 / D-04 / DV-1 / DV-2.
// AGENTS.md "forward-only" exception accepted for Phase 2.1 ONLY (pre-launch +
// zero self-host deployments). Phase 3+ resumes strict forward-only from this
// baseline.
//
// All tests run against the integration Postgres service container that
// tests/setup.ts boots. TEST_DATABASE_URL is the same connection string the
// global setup uses; we open a small read-only pool here only to assert the
// final schema shape.

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

// Plan 02.1-01: Phase 2.1 baseline schema migration assertions.
//
// tests/setup.ts already calls runMigrations() once in beforeAll. We re-run
// here to cover the case where this file is executed in isolation; the runner
// is idempotent (verified by the suite above).
describe("Phase 2.1 baseline schema migration (Plan 02.1-01)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("creates the data_sources table", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='data_sources'`,
      );
      expect(result.rows.length).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("drops the youtube_channels table", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_channels'`,
      );
      expect(result.rows.length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("drops the tracked_youtube_videos table", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='tracked_youtube_videos'`,
      );
      expect(result.rows.length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("drops the game_youtube_channels table", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='game_youtube_channels'`,
      );
      expect(result.rows.length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("creates the source_kind pgEnum", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ value: string }>(
        `select unnest(enum_range(NULL::source_kind))::text as value`,
      );
      const values = result.rows.map((r) => r.value);
      expect(values).toEqual(
        expect.arrayContaining([
          "youtube_channel",
          "reddit_account",
          "twitter_account",
          "telegram_channel",
          "discord_server",
        ]),
      );
    } finally {
      await pool.end();
    }
  });

  it("extends event_kind enum with youtube_video and reddit_post", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ value: string }>(
        `select unnest(enum_range(NULL::event_kind))::text as value`,
      );
      const values = result.rows.map((r) => r.value);
      expect(values).toContain("youtube_video");
      expect(values).toContain("reddit_post");
    } finally {
      await pool.end();
    }
  });

  it("renames audit_action enum to the 2.1 vocabulary", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ value: string }>(
        `select unnest(enum_range(NULL::audit_action))::text as value`,
      );
      const values = result.rows.map((r) => r.value);
      // New 2.1 vocabulary present
      expect(values).toContain("source.added");
      expect(values).toContain("source.removed");
      expect(values).toContain("source.toggled_auto_import");
      expect(values).toContain("event.attached_to_game");
      expect(values).toContain("event.dismissed_from_inbox");
      // Removed Phase 2 vocabulary absent
      expect(values).not.toContain("channel.added");
      expect(values).not.toContain("channel.removed");
      expect(values).not.toContain("channel.attached");
      expect(values).not.toContain("channel.detached");
      expect(values).not.toContain("item.created");
      expect(values).not.toContain("item.deleted");
    } finally {
      await pool.end();
    }
  });

  it("makes events.game_id nullable", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_name='events' and column_name='game_id'`,
      );
      expect(result.rows[0]?.is_nullable).toBe("YES");
    } finally {
      await pool.end();
    }
  });

  it("adds events.author_is_me / source_id / last_polled_at / last_poll_status columns", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name='events' and column_name in ('author_is_me','source_id','last_polled_at','last_poll_status')`,
      );
      const cols = result.rows.map((r) => r.column_name).sort();
      expect(cols).toEqual(["author_is_me", "last_poll_status", "last_polled_at", "source_id"]);
    } finally {
      await pool.end();
    }
  });

  it("adds the events_user_occurred_at_idx index", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename='events' and indexname='events_user_occurred_at_idx'`,
      );
      expect(result.rows.length).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("data_sources carries kind / is_owned_by_me / auto_import / metadata / deleted_at", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name='data_sources' and column_name in ('kind','is_owned_by_me','auto_import','metadata','deleted_at')`,
      );
      const cols = result.rows.map((r) => r.column_name).sort();
      expect(cols).toEqual(["auto_import", "deleted_at", "is_owned_by_me", "kind", "metadata"]);
    } finally {
      await pool.end();
    }
  });

  it("user.theme_preference column exists with default 'system' (D-40 inheritance)", async () => {
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

  it("audit_log.action is of type audit_action", async () => {
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

  it("audit_log gains user_id+action+created_at index for filter-by-action queries", async () => {
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
});

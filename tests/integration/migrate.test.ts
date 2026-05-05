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

  it.skip("makes events.game_id nullable (superseded by Plan 02.1-27 — column DROPPED in 0005)", async () => {
    // The Phase 2.1 baseline made events.game_id nullable to encode inbox
    // semantics (game_id IS NULL). Plan 02.1-27 (UAT-NOTES.md §4.24.G)
    // DROPS the column entirely in favour of the event_games M:N junction.
    // The Plan 02.1-27 describe block below asserts the column is gone.
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

  // Phase 02.2 review (post-fix #4): composite index on (user_id, created_at DESC)
  // for events_per_day quota count. Migration 0009.
  it("adds the events_user_created_at_idx index (Codex post-fix #4)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes where tablename='events' and indexname='events_user_created_at_idx'`,
      );
      expect(result.rows.length).toBe(1);
      // Verify the index shape: btree on (user_id, created_at DESC).
      const indexdef = result.rows[0]!.indexdef;
      expect(indexdef).toMatch(/btree/i);
      expect(indexdef).toMatch(/user_id/);
      expect(indexdef).toMatch(/created_at\s+DESC/i);
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

// Plan 02.1-12: forward-only migration `0001_add_post_kind` extends the
// event_kind pgEnum with a generic platform-agnostic `post` value (Mastodon /
// LinkedIn / Bluesky / Threads / unmapped). Resumes strict forward-only
// migration discipline (CONTEXT D-04 / DV-2) — first migration after the 2.1
// baseline collapse.
describe("Phase 2.1 forward-only migrations (Plan 02.1-12)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("02.1-12: event_kind enum extended with 'post' (forward-only migration 0001 — first after baseline)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.event_kind'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("post");
      expect(values).toContain("youtube_video");
      expect(values).toContain("other");
      expect(values).toHaveLength(10);
    } finally {
      await pool.end();
    }
  });
});

// Plan 02.1-14 (gap closure): forward-only migration
// `0002_add_event_restored_audit_action` extends the audit_action pgEnum with
// `event.restored` — the soft-delete recovery audit verb. Closes Gap 2 from
// 02.1-VERIFICATION.md. Forward-only discipline (CONTEXT D-04 / DV-2) preserved.
describe("Phase 2.1 forward-only migrations (Plan 02.1-14)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("02.1-14: audit_action enum extended with 'event.restored' (forward-only migration 0002)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.audit_action'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("event.restored");
      // Sanity: the prior audit verbs are still present.
      expect(values).toContain("event.deleted");
      expect(values).toContain("game.restored");
      // Total post-Plan-14: 19 (baseline) + 1 (event.restored) = 20.
      // Plan 02.1-24 adds 2 more verbs (event.marked_standalone +
      // event.unmarked_standalone). Length assertion moves to that block to
      // avoid double-counting; here we only assert the lower bound.
      expect(values.length).toBeGreaterThanOrEqual(20);
    } finally {
      await pool.end();
    }
  });
});

// Plan 02.1-27 (round-4 gap closure — UAT-NOTES.md §4.24.G + §4.25.J):
// SPLIT migration pair. 0005_event_games_and_steam_listing_unique_swap is
// pure DDL — CREATE TABLE event_games (M:N junction) + DROP COLUMN
// events.game_id + DROP CONSTRAINT game_steam_listings_user_app_id_unq.
// 0006_add_event_detached_from_game_audit_action is the lone ALTER TYPE
// (audit_action enum gains 'event.detached_from_game'), isolated in its
// own migration file per Pitfall 1 (Postgres 16 ALTER TYPE rules) +
// Plan 02.1-12 precedent.
describe("Plan 02.1-27 — event_games + steam listing unique swap (0005 + 0006 split)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("0005: event_games table exists with composite PK + denormalized user_id", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='event_games'`,
      );
      expect(tableRes.rows.length).toBe(1);

      const colRes = await pool.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
         where table_name='event_games' order by ordinal_position`,
      );
      const cols = colRes.rows.map((r) => r.column_name).sort();
      expect(cols).toEqual(["created_at", "event_id", "game_id", "user_id"]);
    } finally {
      await pool.end();
    }
  });

  it("0005: events.game_id column dropped", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name='events' and column_name='game_id'`,
      );
      expect(result.rows.length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("0005: user-scoped Steam listing unique constraint dropped (game-scoped retained, unconditional)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const userScopedDropped = await pool.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
         where table_name='game_steam_listings'
           and constraint_name='game_steam_listings_user_app_id_unq'`,
      );
      expect(userScopedDropped.rows.length).toBe(0);

      const gameScopedRetained = await pool.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
         where table_name='game_steam_listings'
           and constraint_name='game_steam_listings_game_app_id_unq'`,
      );
      expect(gameScopedRetained.rows.length).toBe(1);

      // Path B: constraint stays UNCONDITIONAL — no partial-WHERE clause.
      // pg_get_constraintdef returns the full definition; assert it has no WHERE.
      const defRes = await pool.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c
         where c.conname = 'game_steam_listings_game_app_id_unq'`,
      );
      expect(defRes.rows[0]?.def ?? "").not.toMatch(/where/i);
    } finally {
      await pool.end();
    }
  });

  it("0006: audit_action enum extended with 'event.detached_from_game'", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.audit_action'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("event.detached_from_game");
      // Sanity: prior verbs from Plans 14 + 24 still present.
      expect(values).toContain("event.attached_to_game");
      expect(values).toContain("event.marked_standalone");
      // Phase 02.2 Plan 02.2-01 (migration 0008) extended the enum with 4
      // new verbs: account.deleted, account.restored, account.exported,
      // quota.limit_hit. Total post-Plan-02.2-01: 23 (post-Plan-27) + 4 = 27.
      expect(values).toContain("account.deleted");
      expect(values).toContain("account.restored");
      expect(values).toContain("account.exported");
      expect(values).toContain("quota.limit_hit");
      expect(values).toHaveLength(27);
    } finally {
      await pool.end();
    }
  });

  it("re-running migrate is a no-op (idempotency — IF NOT EXISTS / IF EXISTS guards on 0005 + 0006)", async () => {
    // runMigrations already ran in beforeAll; second invocation must succeed
    // without error and leave the schema unchanged.
    await runMigrations();
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='event_games'`,
      );
      expect(tableRes.rows.length).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("_journal.json carries idx=5 (0005) and idx=6 (0006) entries", async () => {
    // Read the journal from disk and assert both Plan 27 entries exist.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    const tags = journal.entries.map((e: { idx: number; tag: string }) => `${e.idx}:${e.tag}`);
    expect(tags).toContain("5:0005_event_games_and_steam_listing_unique_swap");
    expect(tags).toContain("6:0006_add_event_detached_from_game_audit_action");
  });
});

// Plan 02.1-24 (round-3 gap closure — UAT-NOTES.md §6.1-redesign): forward-only
// migration `0003_add_event_standalone_audit_actions` extends the audit_action
// pgEnum with `event.marked_standalone` and `event.unmarked_standalone` — the
// two new triage verbs for the user-explicit "not related to any game" state.
// Forward-only discipline (CONTEXT D-04 / DV-2) preserved — third migration
// after the 2.1 baseline collapse.
describe("Phase 2.1 forward-only migrations (Plan 02.1-24)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("02.1-24: audit_action enum extended with 'event.marked_standalone' and 'event.unmarked_standalone' (forward-only migration 0003)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.audit_action'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("event.marked_standalone");
      expect(values).toContain("event.unmarked_standalone");
      // Sanity: prior verbs still present after the additive migration.
      expect(values).toContain("event.restored");
      expect(values).toContain("event.dismissed_from_inbox");
      // Post-Plan-24 added 2 verbs (post-Plan-14 = 20 → post-Plan-24 = 22).
      // Plan 02.1-27 adds `event.detached_from_game` for the M:N detach path,
      // moving the total to 23. The exact-length assertion lives in the Plan
      // 02.1-27 describe block above to avoid double-counting on every future
      // additive enum migration; here we only assert the lower bound.
      expect(values.length).toBeGreaterThanOrEqual(22);
    } finally {
      await pool.end();
    }
  });
});

// Plan 03.0-01: forward-only migration `0010_phase03_baseline` lands the three
// new public-data tables (youtube_video_snapshots / youtube_channel_metadata_cache
// / youtube_service_quota_usage), two new partial indexes on `events`, and 5 new
// audit_action enum verbs (quota.service_throttled, purge.completed,
// auto_import.deferred, poll.failed, event.poll_refreshed). pgboss legacy queue
// rows ('poll.hot', 'poll.warm') are also cleaned up, gated on schema existence
// (pgboss schema is created at boss.start() runtime, not migrate time — so the
// DELETE is conditional and idempotent).
describe("Plan 03.0-01 — Phase 3.0 baseline (migration 0010)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("creates the youtube_video_snapshots table (no user_id — public data, D-07)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_video_snapshots'`,
      );
      expect(tableRes.rows.length).toBe(1);
      // Public-data invariant: NO user_id column. ESLint allowlist mirror.
      const userIdRes = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name='youtube_video_snapshots' and column_name='user_id'`,
      );
      expect(userIdRes.rows.length).toBe(0);
      // bigint counters for popular videos > 2^31 (RESEARCH.md schema).
      const colRes = await pool.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
         where table_name='youtube_video_snapshots' order by ordinal_position`,
      );
      const cols = new Map(colRes.rows.map((r) => [r.column_name, r.data_type]));
      expect(cols.get("view_count")).toBe("bigint");
      expect(cols.get("like_count")).toBe("bigint");
      expect(cols.get("comment_count")).toBe("bigint");
    } finally {
      await pool.end();
    }
  });

  it("creates the youtube_channel_metadata_cache table keyed on channel_id (no user_id)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_channel_metadata_cache'`,
      );
      expect(tableRes.rows.length).toBe(1);
      const userIdRes = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name='youtube_channel_metadata_cache' and column_name='user_id'`,
      );
      expect(userIdRes.rows.length).toBe(0);
      // channel_id is the PK.
      const pkRes = await pool.query<{ column_name: string }>(
        `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_name = kcu.table_name
         where tc.table_name='youtube_channel_metadata_cache'
           and tc.constraint_type='PRIMARY KEY'`,
      );
      expect(pkRes.rows.map((r) => r.column_name)).toEqual(["channel_id"]);
    } finally {
      await pool.end();
    }
  });

  it("creates the youtube_service_quota_usage table with composite PK (date_pacific, api_key_id)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_service_quota_usage'`,
      );
      expect(tableRes.rows.length).toBe(1);
      const userIdRes = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name='youtube_service_quota_usage' and column_name='user_id'`,
      );
      expect(userIdRes.rows.length).toBe(0);
      // Composite PK columns in order: date_pacific, api_key_id.
      const pkRes = await pool.query<{ column_name: string; ordinal_position: number }>(
        `select kcu.column_name, kcu.ordinal_position
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_name = kcu.table_name
         where tc.table_name='youtube_service_quota_usage'
           and tc.constraint_type='PRIMARY KEY'
         order by kcu.ordinal_position`,
      );
      expect(pkRes.rows.map((r) => r.column_name)).toEqual(["date_pacific", "api_key_id"]);
    } finally {
      await pool.end();
    }
  });

  it("creates the idx_events_last_polled_at partial index (WHERE last_polled_at IS NOT NULL)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where tablename='events' and indexname='idx_events_last_polled_at'`,
      );
      expect(result.rows.length).toBe(1);
      const def = result.rows[0]!.indexdef;
      expect(def).toMatch(/last_polled_at/);
      expect(def).toMatch(/where/i);
      expect(def).toMatch(/last_polled_at\s+is\s+not\s+null/i);
    } finally {
      await pool.end();
    }
  });

  it("creates the events_user_kind_ext_active_unq partial unique index (WHERE external_id IS NOT NULL AND deleted_at IS NULL)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where tablename='events' and indexname='events_user_kind_ext_active_unq'`,
      );
      expect(result.rows.length).toBe(1);
      const def = result.rows[0]!.indexdef;
      expect(def).toMatch(/unique/i);
      expect(def).toMatch(/user_id/);
      expect(def).toMatch(/kind/);
      expect(def).toMatch(/external_id/);
      expect(def).toMatch(/where/i);
      expect(def).toMatch(/external_id\s+is\s+not\s+null/i);
      expect(def).toMatch(/deleted_at\s+is\s+null/i);
    } finally {
      await pool.end();
    }
  });

  it("audit_action enum extended with 5 new Phase 3.0 verbs", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.audit_action'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("quota.service_throttled");
      expect(values).toContain("purge.completed");
      expect(values).toContain("auto_import.deferred");
      expect(values).toContain("poll.failed");
      expect(values).toContain("event.poll_refreshed");
      // Sanity: prior verbs still present.
      expect(values).toContain("quota.limit_hit");
      expect(values).toContain("event.detached_from_game");
      // 27 (post-Plan-02.2-01) + 5 (Plan 03.0-01) = 32.
      expect(values).toHaveLength(32);
    } finally {
      await pool.end();
    }
  });

  it("INSERT into youtube_video_snapshots is idempotent on (video_id, polled_at) — ON CONFLICT DO NOTHING no-ops", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const polledAt = new Date("2026-05-06T12:00:00Z");
      const insert = async () =>
        pool.query(
          `insert into youtube_video_snapshots (id, video_id, polled_at, view_count, like_count, comment_count)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (video_id, polled_at) do nothing`,
          ["01HX0000000000000000000001", "dQw4w9WgXcQ", polledAt, 100, 10, 5],
        );
      const first = await insert();
      expect(first.rowCount).toBe(1);
      // Same (video_id, polled_at) — duplicate must silently no-op.
      const second = await insert();
      expect(second.rowCount).toBe(0);
      const countRes = await pool.query<{ count: string }>(
        `select count(*)::text as count from youtube_video_snapshots
         where video_id='dQw4w9WgXcQ' and polled_at=$1`,
        [polledAt],
      );
      expect(countRes.rows[0]?.count).toBe("1");
    } finally {
      await pool.end();
    }
  });

  it("_journal.json carries idx=10 (0010_phase03_baseline) entry", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    const tags = journal.entries.map((e: { idx: number; tag: string }) => `${e.idx}:${e.tag}`);
    expect(tags).toContain("10:0010_phase03_baseline");
  });
});

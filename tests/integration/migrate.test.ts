import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations, migrationsApplied } from "../../src/lib/server/db/migrate.js";
import { eventKindEnum } from "../../src/lib/server/db/schema/events.js";

// Validates two invariants:
//   1. migrations idempotent on second boot
//   2. advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)
//
// The migration tree starts from `0000_phase02_1_baseline.sql`, which
// collapsed prior pre-launch migrations into a single baseline (a one-time
// exception to AGENTS.md "forward-only" accepted pre-launch with zero
// self-host deployments). Subsequent migrations resume strict forward-only.
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

// Baseline schema migration assertions.
//
// tests/setup.ts already calls runMigrations() once in beforeAll. We re-run
// here to cover the case where this file is executed in isolation; the runner
// is idempotent (verified by the suite above).
describe("baseline schema migration", () => {
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

  it("youtube_channels table EXISTS (reintroduced via migration 0014 rename — youtube_channel_metadata_cache → youtube_channels)", async () => {
    // The baseline (migration 0000) DROPPED the legacy youtube_channels
    // table from the v1 schema. Migration 0014 (2026-05-06) RENAMED
    // youtube_channel_metadata_cache
    // (from migration 0010) to youtube_channels — the "_metadata_cache"
    // suffix was a misnomer; this IS the local copy of public YouTube
    // channel data, not a regeneratable cache. After the rename, the
    // youtube_channels table is BACK in the schema, but with a different
    // column shape from the legacy v1 table (channel_id PK +
    // uploads_playlist_id, not the v1 game_id FK shape).
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_channels'`,
      );
      expect(result.rows.length).toBe(1);
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
      // Removed vocabulary absent
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

  it.skip("makes events.game_id nullable (superseded — column DROPPED in 0005)", async () => {
    // The baseline made events.game_id nullable to encode inbox semantics
    // (game_id IS NULL). Migration 0005 DROPS the column entirely in
    // favour of the event_games M:N junction. The describe block below
    // asserts the column is gone.
  });

  it("adds events.author_is_me / source_id columns", async () => {
    // Per-video refactor (migration 0016, 2026-05-06): events.last_polled_at
    // and last_poll_status were DROPPED from this table — polling state now
    // lives on youtube_videos (one source of truth per video). The
    // assertions below cover what events still owns: tenant + relation +
    // discriminator columns. youtube_videos.last_polled_at coverage lives
    // in the per-video describe block further down.
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name='events' and column_name in ('author_is_me','source_id','last_polled_at','last_poll_status')`,
      );
      const cols = result.rows.map((r) => r.column_name).sort();
      expect(cols).toEqual(["author_is_me", "source_id"]);
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

  // Composite index on (user_id, created_at DESC) for events_per_day
  // quota count. Migration 0009.
  it("adds the events_user_created_at_idx index", async () => {
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

  it("user.theme_preference column exists with default 'system'", async () => {
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

// Forward-only migration `0001_add_post_kind` extends the event_kind
// pgEnum with a generic platform-agnostic `post` value (Mastodon /
// LinkedIn / Bluesky / Threads / unmapped). First migration after the
// baseline collapse.
describe("forward-only migrations — 0001_add_post_kind", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("event_kind enum extended with 'post' (forward-only migration 0001 — first after baseline)", async () => {
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
      expect(values).toContain("instagram_post");
      expect(values).toContain("tiktok_post");
      // Derived from the schema enum (not a hardcoded count) so adding a kind
      // can't silently strand this assertion — DB enum must mirror the schema.
      expect([...values].sort()).toEqual([...eventKindEnum.enumValues].sort());
    } finally {
      await pool.end();
    }
  });
});

// Forward-only migration `0002_add_event_restored_audit_action` extends
// the audit_action pgEnum with `event.restored` — the soft-delete
// recovery audit verb.
describe("forward-only migrations — 0002_add_event_restored_audit_action", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("audit_action enum extended with 'event.restored' (forward-only migration 0002)", async () => {
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
      // Total: 19 (baseline) + 1 (event.restored) = 20.
      // Later migrations add more verbs (event.marked_standalone +
      // event.unmarked_standalone). Length assertion moves to that block
      // to avoid double-counting; here we only assert the lower bound.
      expect(values.length).toBeGreaterThanOrEqual(20);
    } finally {
      await pool.end();
    }
  });
});

// Split migration pair. 0005_event_games_and_steam_listing_unique_swap
// is pure DDL — CREATE TABLE event_games (M:N junction) + DROP COLUMN
// events.game_id + DROP CONSTRAINT game_steam_listings_user_app_id_unq.
// 0006_add_event_detached_from_game_audit_action is the lone ALTER TYPE
// (audit_action enum gains 'event.detached_from_game'), isolated in its
// own migration file (Postgres 16 ALTER TYPE rules require splitting the
// transaction).
describe("event_games + steam listing unique swap (0005 + 0006 split)", () => {
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
      // Sanity: prior verbs still present.
      expect(values).toContain("event.attached_to_game");
      expect(values).toContain("event.marked_standalone");
      // Migration 0008 extended the enum with 4 new verbs:
      // account.deleted, account.restored, account.exported, quota.limit_hit.
      // Migration 0010 added 5 more: quota.service_throttled,
      // purge.completed, auto_import.deferred, poll.failed,
      // event.poll_refreshed. Migration 0023 added 1 more:
      // source.refresh_content_requested.
      // Plan 03.1-02 added 4 Reddit verbs (queue_drained, deletion_propagated,
      // cap_exhausted, adapter_degraded).
      // Phase 03.4 Plan 06 (migration 0042) added 4 bulk-action verbs
      // (events.bulk_edit, events.bulk_delete, events.delete_forever,
      // events.purge_stale).
      // Migration 0049 added 2 delete-forever verbs:
      // source.delete_forever, game.delete_forever.
      // Total: 23 + 4 (0008) + 5 (0010) + 1 (0023) + 4 (0030) + 4 (0042) + 2 (0049)
      //        + 2 (Phase 03.2: wishlist.imported + listing.delete_forever) + 2 (Phase 08: social.provider_throttled + social.budget_exhausted) + 1 (Phase 09: telegram.queue_drained) = 48.
      expect(values).toContain("account.deleted");
      expect(values).toContain("account.restored");
      expect(values).toContain("account.exported");
      expect(values).toContain("quota.limit_hit");
      expect(values).toContain("quota.service_throttled");
      expect(values).toContain("purge.completed");
      expect(values).toContain("auto_import.deferred");
      expect(values).toContain("poll.failed");
      expect(values).toContain("event.poll_refreshed");
      expect(values).toContain("source.refresh_content_requested");
      expect(values).toContain("reddit.queue_drained");
      expect(values).toContain("reddit.deletion_propagated");
      expect(values).toContain("reddit.cap_exhausted");
      expect(values).toContain("reddit.adapter_degraded");
      // Phase 03.4 Plan 06 audit verbs (migration 0042).
      expect(values).toContain("events.bulk_edit");
      expect(values).toContain("events.bulk_delete");
      expect(values).toContain("events.delete_forever");
      expect(values).toContain("events.purge_stale");
      // Migration 0049 delete-forever verbs.
      expect(values).toContain("source.delete_forever");
      expect(values).toContain("game.delete_forever");
      // Phase 03.2 verbs (migrations 0052 / 0053).
      expect(values).toContain("wishlist.imported");
      expect(values).toContain("listing.delete_forever");
      // Phase 08 social provider verbs (migration 0055).
      expect(values).toContain("social.provider_throttled");
      expect(values).toContain("social.budget_exhausted");
      // Phase 09 Telegram observability verb (migration 0058).
      expect(values).toContain("telegram.queue_drained");
      expect(values).toHaveLength(48);
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
    // Read the journal from disk and assert both entries exist.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    const tags = journal.entries.map((e: { idx: number; tag: string }) => `${e.idx}:${e.tag}`);
    expect(tags).toContain("5:0005_event_games_and_steam_listing_unique_swap");
    expect(tags).toContain("6:0006_add_event_detached_from_game_audit_action");
  });
});

// Forward-only migration `0003_add_event_standalone_audit_actions`
// extends the audit_action pgEnum with `event.marked_standalone` and
// `event.unmarked_standalone` — the two new triage verbs for the
// user-explicit "not related to any game" state.
describe("forward-only migrations — 0003_add_event_standalone_audit_actions", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("audit_action enum extended with 'event.marked_standalone' and 'event.unmarked_standalone' (forward-only migration 0003)", async () => {
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
      // Added 2 verbs (20 → 22). A later migration adds
      // `event.detached_from_game` for the M:N detach path, moving the
      // total to 23. The exact-length assertion lives in the describe
      // block above to avoid double-counting on every future additive
      // enum migration; here we only assert the lower bound.
      expect(values.length).toBeGreaterThanOrEqual(22);
    } finally {
      await pool.end();
    }
  });
});

// Forward-only migration `0010_phase03_baseline` lands three new
// public-data tables (youtube_video_snapshots / youtube_channels /
// youtube_service_quota_usage), two new partial indexes on `events`, and
// 5 new audit_action enum verbs (quota.service_throttled,
// purge.completed, auto_import.deferred, poll.failed,
// event.poll_refreshed). pgboss legacy queue rows ('poll.hot',
// 'poll.warm') are also cleaned up, gated on schema existence (pgboss
// schema is created at boss.start() runtime, not migrate time — so the
// DELETE is conditional and idempotent).
describe("migration 0010 baseline", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("creates the youtube_video_snapshots table (no user_id — public data)", async () => {
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
      // bigint counters for popular videos > 2^31.
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

  it("creates the youtube_channels table keyed on channel_id (no user_id)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableRes = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename='youtube_channels'`,
      );
      expect(tableRes.rows.length).toBe(1);
      const userIdRes = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name='youtube_channels' and column_name='user_id'`,
      );
      expect(userIdRes.rows.length).toBe(0);
      // channel_id is the PK.
      const pkRes = await pool.query<{ column_name: string }>(
        `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
          and tc.table_name = kcu.table_name
         where tc.table_name='youtube_channels'
           and tc.constraint_type='PRIMARY KEY'`,
      );
      expect(pkRes.rows.map((r) => r.column_name)).toEqual(["channel_id"]);
    } finally {
      await pool.end();
    }
  });

  it("creates the youtube_service_quota_usage table with composite PK (date_pacific, api_key_id, pool_kind)", async () => {
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
      // Composite PK columns in order: date_pacific, api_key_id, pool_kind.
      // pool_kind discriminator added so reconcileReservoirsOnBoot debits
      // each in-memory reservoir accurately.
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
      expect(pkRes.rows.map((r) => r.column_name)).toEqual([
        "date_pacific",
        "api_key_id",
        "pool_kind",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("creates the idx_youtube_videos_published_at partial index (WHERE published_at IS NOT NULL)", async () => {
    // Per-video refactor (migration 0016, 2026-05-06): the partial index on
    // events.last_polled_at was DROPPED alongside the column. Tier-driven
    // SELECT queries now JOIN events to youtube_videos and filter on
    // youtube_videos.published_at — the partial index here narrows the
    // working set to videos whose channel-context-backfill has populated
    // metadata (NULL published_at = 'pending' tier; not pollable).
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where tablename='youtube_videos' and indexname='idx_youtube_videos_published_at'`,
      );
      expect(result.rows.length).toBe(1);
      const def = result.rows[0]!.indexdef;
      expect(def).toMatch(/published_at/);
      expect(def).toMatch(/where/i);
      expect(def).toMatch(/published_at\s+is\s+not\s+null/i);
    } finally {
      await pool.end();
    }
  });

  it("does NOT carry the events_user_kind_ext_active_unq index (DROPPED in migration 0012)", async () => {
    // Migration 0012 (2026-05-06): the partial unique
    // (user_id, kind, external_id) index was DROPPED. UAT direction —
    // operator wants to log multiple promotion events for the same video
    // (e.g. "Released video X" + "Promo stream for X" + "Reddit post for
    // X" — same external_id, three diary entries). Auto-import idempotency
    // moved to a pre-INSERT SELECT in the worker. The
    // events_user_kind_source_ext_unq index (in this baseline) still
    // catches accidental double-inserts on the AUTO-IMPORT path; manual
    // paste is intentionally permissive.
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
         where tablename='events' and indexname='events_user_kind_ext_active_unq'`,
      );
      expect(result.rows.length).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("audit_action enum extended with 5 new verbs", async () => {
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
      // 27 + 5 (migration 0010) + 1 (migration 0023) + 4 (migration 0030 Reddit)
      // + 4 (migration 0042 Phase 03.4 bulk verbs) + 2 (migration 0049 delete-forever)
      // + 2 (Phase 03.2: wishlist.imported + listing.delete_forever) + 2 (Phase 08: social.provider_throttled + social.budget_exhausted) + 1 (Phase 09: telegram.queue_drained) = 48.
      expect(values).toContain("source.refresh_content_requested");
      expect(values).toContain("reddit.queue_drained");
      // Phase 03.4 Plan 06 audit verbs (migration 0042).
      expect(values).toContain("events.bulk_edit");
      expect(values).toContain("events.bulk_delete");
      expect(values).toContain("events.delete_forever");
      expect(values).toContain("events.purge_stale");
      // Migration 0049 delete-forever verbs.
      expect(values).toContain("source.delete_forever");
      expect(values).toContain("game.delete_forever");
      // Phase 03.2 verbs (migrations 0052 / 0053).
      expect(values).toContain("wishlist.imported");
      expect(values).toContain("listing.delete_forever");
      // Phase 08 social provider verbs (migration 0055).
      expect(values).toContain("social.provider_throttled");
      expect(values).toContain("social.budget_exhausted");
      // Phase 09 Telegram observability verb (migration 0058).
      expect(values).toContain("telegram.queue_drained");
      expect(values).toHaveLength(48);
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
           VALUES ($1, $2, $3, $4, $5, $6)
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

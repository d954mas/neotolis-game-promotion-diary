// Phase 03.1 Plan 02 — Reddit schema migration assertions.
//
// Asserts the post-migrate shape of the 8 Reddit tables + the two
// enum extensions + the CHECK constraints. The base migration runner
// runs in tests/setup.ts beforeAll; this suite just queries
// information_schema / pg_catalog and exercises a couple of INSERTs to
// prove the constraints fire.
//
// Pattern mirrors tests/integration/migrate.test.ts for the YouTube
// baseline assertions in plan 0010. Forward-only invariant: this test
// pins the post-migrate schema shape so a future migration that drops a
// table accidentally trips here, not in production.

import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations } from "../../src/lib/server/db/migrate.js";

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/neotolis_test";

describe("migration 0030 — Phase 03.1 Reddit schema", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("source_kind enum extended with reddit_subreddit (additive — reddit_account preserved)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ value: string }>(
        `select unnest(enum_range(NULL::source_kind))::text as value`,
      );
      const values = result.rows.map((r) => r.value);
      expect(values).toContain("reddit_account");
      expect(values).toContain("reddit_subreddit");
      // Sanity: prior values still present (additive migration).
      expect(values).toContain("youtube_channel");
      expect(values).toContain("twitter_account");
      expect(values).toContain("telegram_channel");
      expect(values).toContain("discord_server");
    } finally {
      await pool.end();
    }
  });

  it("audit_action enum extended with 4 new Reddit verbs", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ enumlabel: string }>(
        `select enumlabel from pg_enum
         where enumtypid = 'public.audit_action'::regtype
         order by enumsortorder`,
      );
      const values = result.rows.map((r) => r.enumlabel);
      expect(values).toContain("reddit.queue_drained");
      expect(values).toContain("reddit.deletion_propagated");
      expect(values).toContain("reddit.cap_exhausted");
      expect(values).toContain("reddit.adapter_degraded");
      // Sanity: prior verbs still present.
      expect(values).toContain("source.refresh_content_requested");
      expect(values).toContain("event.poll_refreshed");
    } finally {
      await pool.end();
    }
  });

  it("creates 9 Reddit tables (7 public-data + 1 queue + 1 pacer) with no user_id columns on public-data tables", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const tableResult = await pool.query<{ tablename: string }>(
        `select tablename from pg_tables
         where schemaname='public' and tablename like 'reddit_%'
         order by tablename`,
      );
      const tables = tableResult.rows.map((r) => r.tablename);
      expect(tables).toEqual([
        "reddit_pacer",
        "reddit_post_snapshots",
        "reddit_posts",
        "reddit_refresh_queue",
        "reddit_subreddit_baselines",
        "reddit_subreddit_snapshots",
        "reddit_subreddits_cache",
        "reddit_user_snapshots",
        "reddit_users_cache",
      ]);

      // Public-data invariant: 7 tables MUST NOT have a user_id column.
      // reddit_refresh_queue is the one exception (queue payload-scoped).
      const publicDataTables = [
        "reddit_posts",
        "reddit_post_snapshots",
        "reddit_users_cache",
        "reddit_user_snapshots",
        "reddit_subreddits_cache",
        "reddit_subreddit_snapshots",
        "reddit_subreddit_baselines",
      ];
      for (const t of publicDataTables) {
        const userIdRes = await pool.query<{ column_name: string }>(
          `select column_name from information_schema.columns
           where table_schema='public' and table_name=$1 and column_name='user_id'`,
          [t],
        );
        expect(userIdRes.rows.length, `${t} must NOT have user_id`).toBe(0);
      }

      // reddit_refresh_queue MUST have user_id (nullable, payload-scoped).
      const queueUserIdRes = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
         where table_schema='public' and table_name='reddit_refresh_queue' and column_name='user_id'`,
      );
      expect(queueUserIdRes.rows.length).toBe(1);
      expect(queueUserIdRes.rows[0]?.is_nullable).toBe("YES");
    } finally {
      await pool.end();
    }
  });

  it("reddit_post_snapshots enforces UNIQUE(post_id, polled_at) — D-RDT-SNAPSHOTS idempotency", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      // Seed the parent reddit_posts row first (FK target).
      await pool.query(
        `insert into reddit_posts (post_id, subreddit, permalink, title, submitted_at)
         values ('t3_test_uniq', 'IndieDev', '/r/IndieDev/comments/test_uniq/', 'test', now())`,
      );
      const polledAt = new Date("2026-05-14T05:30:00.000Z");
      const first = await pool.query(
        `insert into reddit_post_snapshots (post_id, polled_at, status, score)
         values ('t3_test_uniq', $1, 'ok', 5)
         on conflict (post_id, polled_at) do nothing`,
        [polledAt],
      );
      expect(first.rowCount).toBe(1);
      // Duplicate (same minute-truncated polled_at) — must silently no-op
      // under ON CONFLICT DO NOTHING.
      const second = await pool.query(
        `insert into reddit_post_snapshots (post_id, polled_at, status, score)
         values ('t3_test_uniq', $1, 'ok', 7)
         on conflict (post_id, polled_at) do nothing`,
        [polledAt],
      );
      expect(second.rowCount).toBe(0);
      // Exactly one row.
      const countRes = await pool.query<{ count: string }>(
        `select count(*)::text as count from reddit_post_snapshots
         where post_id='t3_test_uniq' and polled_at=$1`,
        [polledAt],
      );
      expect(countRes.rows[0]?.count).toBe("1");
    } finally {
      await pool.end();
    }
  });

  it("reddit_refresh_queue.queue_name CHECK rejects values outside the 4 lanes", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      let caught: Error | null = null;
      try {
        await pool.query(
          `insert into reddit_refresh_queue (queue_name, type, payload, priority)
           values ('bogus_lane', 'sub_poll', '{}'::jsonb, 0)`,
        );
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      const errCode = (caught as { code?: string } | null)?.code;
      expect(errCode).toBe("23514");
    } finally {
      await pool.end();
    }
  });

  it("reddit_refresh_queue.type CHECK rejects values outside the 4 work types", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      let caught: Error | null = null;
      try {
        await pool.query(
          `insert into reddit_refresh_queue (queue_name, type, payload, priority)
           values ('user_source', 'bogus_type', '{}'::jsonb, 0)`,
        );
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect((caught as { code?: string } | null)?.code).toBe("23514");
    } finally {
      await pool.end();
    }
  });

  it("reddit_refresh_queue.status CHECK accepts the 4 lifecycle states and rejects others", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      // Accept: pending (default), processing, done, dead_letter.
      for (const status of ["pending", "processing", "done", "dead_letter"]) {
        await pool.query(
          `insert into reddit_refresh_queue (queue_name, type, payload, priority, status)
           values ('service_source', 'sub_poll', '{}'::jsonb, 0, $1)`,
          [status],
        );
      }
      // Reject anything else.
      let caught: Error | null = null;
      try {
        await pool.query(
          `insert into reddit_refresh_queue (queue_name, type, payload, priority, status)
           values ('service_source', 'sub_poll', '{}'::jsonb, 0, 'in_flight')`,
        );
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect((caught as { code?: string } | null)?.code).toBe("23514");
    } finally {
      await pool.end();
    }
  });

  it("audit_log INSERT with action='reddit.queue_drained' succeeds (enum extension landed)", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      // Seed a user (audit_log.user_id is plain text post-0011 drop FK,
      // so any non-null string works).
      const result = await pool.query<{ id: string }>(
        `insert into audit_log (id, user_id, action, ip_address, metadata)
         values (gen_random_uuid()::text, 'test-user-reddit', 'reddit.queue_drained',
                 '127.0.0.1', '{}'::jsonb)
         returning id`,
      );
      expect(result.rowCount).toBe(1);
      expect(typeof result.rows[0]?.id).toBe("string");
    } finally {
      await pool.end();
    }
  });

  it("partial pending index exists on reddit_refresh_queue", async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
    try {
      const result = await pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where tablename='reddit_refresh_queue' and indexname='idx_reddit_refresh_queue_pending'`,
      );
      expect(result.rows.length).toBe(1);
      const def = result.rows[0]!.indexdef;
      // Partial WHERE clause on status='pending'.
      expect(def).toMatch(/where/i);
      expect(def).toMatch(/'pending'/);
    } finally {
      await pool.end();
    }
  });

  it("_journal.json carries idx=30 (0030_phase03_1_reddit_schema) entry", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    const tags = journal.entries.map((e: { idx: number; tag: string }) => `${e.idx}:${e.tag}`);
    expect(tags).toContain("30:0030_phase03_1_reddit_schema");
  });
});

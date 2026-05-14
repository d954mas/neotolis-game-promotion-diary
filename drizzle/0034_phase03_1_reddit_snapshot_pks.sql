-- Phase 03.1 follow-up: snapshot tables' explicit primary keys +
-- reddit_subreddit_baselines.subreddit FK.
--
-- Pre-fix shape (0030):
--   - reddit_post_snapshots / reddit_user_snapshots / reddit_subreddit_snapshots
--     each had a uniqueIndex on (entity_id, polled_at). Same uniqueness
--     guarantee as a composite primary key, but Postgres treated the
--     tables as PK-less: logical replication identity could not be
--     `DEFAULT` (uses PK), and some ORM tooling treats PK-less tables
--     as second-class for `$inferSelect` shape inference.
--   - reddit_subreddit_baselines.subreddit was a bare `text NOT NULL`
--     column. An orphan baseline row could survive after its
--     reddit_subreddits_cache row was deleted (no cascade path exists
--     today, but the orphan is silently misleading: /feed would render
--     baselines for a sub the worker no longer tracks).
--
-- This migration:
--   1. Drops the three unique indexes.
--   2. Adds composite PRIMARY KEY constraints on the same columns
--      (Postgres auto-creates the supporting unique index — same
--      read-path shape).
--   3. Adds FK reddit_subreddit_baselines.subreddit → reddit_subreddits_cache.name.
--
-- All forward-only, idempotent (IF EXISTS / IF NOT EXISTS guards).

DROP INDEX IF EXISTS "reddit_post_snapshots_post_id_polled_at_uq";
--> statement-breakpoint

ALTER TABLE "reddit_post_snapshots"
  ADD CONSTRAINT "reddit_post_snapshots_pk"
  PRIMARY KEY ("post_id", "polled_at");
--> statement-breakpoint

DROP INDEX IF EXISTS "reddit_user_snapshots_username_polled_at_uq";
--> statement-breakpoint

ALTER TABLE "reddit_user_snapshots"
  ADD CONSTRAINT "reddit_user_snapshots_pk"
  PRIMARY KEY ("username", "polled_at");
--> statement-breakpoint

DROP INDEX IF EXISTS "reddit_subreddit_snapshots_subreddit_polled_at_uq";
--> statement-breakpoint

ALTER TABLE "reddit_subreddit_snapshots"
  ADD CONSTRAINT "reddit_subreddit_snapshots_pk"
  PRIMARY KEY ("subreddit", "polled_at");
--> statement-breakpoint

-- FK on baselines.subreddit → reddit_subreddits_cache.name.
-- ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS is not supported in
-- Postgres; use a guarded DO block instead (mirrors 0031's approach).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reddit_subreddit_baselines_subreddit_fk'
      AND conrelid = 'public.reddit_subreddit_baselines'::regclass
  ) THEN
    ALTER TABLE "reddit_subreddit_baselines"
      ADD CONSTRAINT "reddit_subreddit_baselines_subreddit_fk"
      FOREIGN KEY ("subreddit") REFERENCES "reddit_subreddits_cache"("name");
  END IF;
END$$;

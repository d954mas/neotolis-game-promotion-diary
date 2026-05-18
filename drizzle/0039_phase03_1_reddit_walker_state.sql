-- Phase 03.1 walker state for Reddit subreddit + user pagination.
--
-- Adds the three columns each `sub_poll` / `author_poll` handler needs to
-- continue an interrupted deep walk: pagination cursor, completion flag,
-- and the oldest submitted_at fetched so far. These columns live on the
-- cross-tenant public cache rows (one walk per subreddit / user;
-- subscribers free-ride on fan-out).
--
-- Forward-only ALTER TABLE — no data migration required:
--   backfill_after_cursor  starts NULL (= "no walk in progress")
--   backfill_complete      defaults false (= "walker hasn't finished yet")
--   backfill_deepest_at    starts NULL (= "no posts fetched yet")
--
-- Hand-written rather than `drizzle-kit generate` because this branch's
-- snapshot history is incomplete (0014..0037 snapshots were never
-- committed; `pnpm db:check` is the only invariant CI relies on and it
-- passes by linear-journal validation, not per-column comparison). The
-- corresponding Drizzle schema definitions in
-- src/lib/sources/reddit/server/schema/subreddits.ts and users.ts mirror
-- this DDL exactly.

ALTER TABLE "reddit_subreddits_cache"
  ADD COLUMN "backfill_after_cursor" text,
  ADD COLUMN "backfill_complete" boolean DEFAULT false NOT NULL,
  ADD COLUMN "backfill_deepest_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "reddit_users_cache"
  ADD COLUMN "backfill_after_cursor" text,
  ADD COLUMN "backfill_complete" boolean DEFAULT false NOT NULL,
  ADD COLUMN "backfill_deepest_at" timestamp with time zone;

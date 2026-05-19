-- Phase 03.1 Plan 02 — Reddit adapter schema. Forward-only.
--
-- Lands the foundation for the Reddit public-`.json` adapter (DV-RDT-7).
-- All 8 tables under src/lib/sources/reddit/server/schema/ (7 public-data
-- caches + 1 SQL queue table), the source_kind enum extension, the
-- audit_action enum extension (4 new Reddit verbs), and the CHECK
-- constraints enforced at the DB level so the worker's SQL inserts can't
-- drift from D-RDT-CACHE-FIELDS contracts.
--
-- Schema layout (D-RDT-CACHE-TABLES):
--   PUBLIC-DATA — no user_id by design (ESLint allowlist mirror):
--     reddit_posts                 (post identity + metadata + last_snapshot_at)
--     reddit_post_snapshots        (time-series stats per post)
--     reddit_users_cache           (author identity + karma + account_age)
--     reddit_user_snapshots        (time-series karma; OWNED accounts only)
--     reddit_subreddits_cache      (subreddit metadata + raw rules)
--     reddit_subreddit_snapshots   (time-series subscribers/active per sub)
--     reddit_subreddit_baselines   (pre-computed median/p75 per sub)
--   QUEUE TABLE — payload-scoped:
--     reddit_refresh_queue         (4-priority work queue for batch-worker)
--
-- ALTER TYPE notes (Postgres 16 rules):
--   - ALTER TYPE ADD VALUE must be its own statement-breakpoint (each
--     value's transaction must commit before the value is usable).
--   - IF NOT EXISTS makes each statement idempotent across re-runs
--     (precedent: 0010 baseline + 0023 refresh-content).
--
-- D-RDT-SNAPSHOTS idempotency: every *_snapshots table has UNIQUE
-- (key, polled_at) where the worker minute-truncates `polled_at` before
-- INSERT. Two retries inside the same minute collapse to one row via
-- INSERT ... ON CONFLICT DO NOTHING.
--
-- D-RDT-DELETION-PROPAGATION: reddit_posts.deletion_detected_at +
-- reddit_posts.author / author_fullname nullability encode the
-- Reddit Public Content Policy 48h author-purge contract enforced by
-- the daily deletion-propagation cron (plan 03.1-05B).

ALTER TYPE "public"."source_kind" ADD VALUE IF NOT EXISTS 'reddit_subreddit' AFTER 'reddit_account';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'reddit.queue_drained';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'reddit.deletion_propagated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'reddit.cap_exhausted';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'reddit.adapter_degraded';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_posts" (
  "post_id" text PRIMARY KEY NOT NULL,
  "subreddit" text NOT NULL,
  "author" text,
  "author_fullname" text,
  "permalink" text NOT NULL,
  "title" text NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_snapshot_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deletion_detected_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_users_cache" (
  "username" text PRIMARY KEY NOT NULL,
  "reddit_id" text,
  "account_age_days" integer,
  "link_karma" integer,
  "comment_karma" integer,
  "total_karma" integer,
  "is_suspended" boolean DEFAULT false NOT NULL,
  "last_metadata_refresh_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_subreddits_cache" (
  "name" text PRIMARY KEY NOT NULL,
  "subreddit_id" text,
  "subscribers" integer,
  "accounts_active" integer,
  "description" text,
  "public_description" text,
  "submission_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rules_raw_json" jsonb,
  "rules_fetched_at" timestamp with time zone,
  "over18" boolean DEFAULT false NOT NULL,
  "subreddit_type" text,
  "last_metadata_refresh_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_post_snapshots" (
  "post_id" text NOT NULL,
  "polled_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "score" integer,
  "num_comments" integer,
  "awards_total" integer,
  "upvote_ratio" real,
  "removed_by_category" text,
  CONSTRAINT "reddit_post_snapshots_post_id_fk"
    FOREIGN KEY ("post_id") REFERENCES "reddit_posts"("post_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_user_snapshots" (
  "username" text NOT NULL,
  "polled_at" timestamp with time zone NOT NULL,
  "link_karma" integer,
  "comment_karma" integer,
  "total_karma" integer,
  CONSTRAINT "reddit_user_snapshots_username_fk"
    FOREIGN KEY ("username") REFERENCES "reddit_users_cache"("username")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_subreddit_snapshots" (
  "subreddit" text NOT NULL,
  "polled_at" timestamp with time zone NOT NULL,
  "subscribers" integer,
  "accounts_active" integer,
  CONSTRAINT "reddit_subreddit_snapshots_subreddit_fk"
    FOREIGN KEY ("subreddit") REFERENCES "reddit_subreddits_cache"("name")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_subreddit_baselines" (
  "subreddit" text NOT NULL,
  "window_label" text NOT NULL,
  "computed_at" timestamp with time zone NOT NULL,
  "sample_size" integer NOT NULL,
  "median_score_24h" real,
  "p75_score_24h" real,
  "median_comments_24h" real,
  "p75_comments_24h" real,
  "median_upvote_ratio_24h" real,
  CONSTRAINT "reddit_subreddit_baselines_pk" PRIMARY KEY ("subreddit", "window_label")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reddit_refresh_queue" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "queue_name" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "user_id" text,
  "priority" smallint NOT NULL,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "status" text DEFAULT 'pending' NOT NULL
);--> statement-breakpoint

-- CHECK constraints — DB-level defense for the contracts the worker
-- relies on (D-RDT-CACHE-FIELDS). Each lane / type / status / window /
-- snapshot-status string is whitelisted so a raw-SQL INSERT with a
-- mistyped string surfaces 23514 (check_violation) instead of silently
-- queueing a job nobody dequeues.
ALTER TABLE "reddit_refresh_queue"
  ADD CONSTRAINT "reddit_refresh_queue_queue_name_check"
  CHECK ("queue_name" IN ('service_source', 'service_post', 'user_source', 'user_post'));--> statement-breakpoint

ALTER TABLE "reddit_refresh_queue"
  ADD CONSTRAINT "reddit_refresh_queue_type_check"
  CHECK ("type" IN ('sub_poll', 'author_poll', 'post_single', 'post_batch'));--> statement-breakpoint

ALTER TABLE "reddit_refresh_queue"
  ADD CONSTRAINT "reddit_refresh_queue_status_check"
  CHECK ("status" IN ('pending', 'processing', 'done', 'dead_letter'));--> statement-breakpoint

ALTER TABLE "reddit_subreddit_baselines"
  ADD CONSTRAINT "reddit_subreddit_baselines_window_label_check"
  CHECK ("window_label" IN ('30d', 'all_time'));--> statement-breakpoint

ALTER TABLE "reddit_post_snapshots"
  ADD CONSTRAINT "reddit_post_snapshots_status_check"
  CHECK ("status" IN ('ok', 'removed', 'archived', 'not_found'));--> statement-breakpoint

-- Indexes — match drizzle/0030's Drizzle TS schema verbatim.
CREATE INDEX IF NOT EXISTS "idx_reddit_posts_subreddit_submitted"
  ON "reddit_posts" USING btree ("subreddit", "submitted_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_posts_author_submitted"
  ON "reddit_posts" USING btree ("author", "submitted_at")
  WHERE "author" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_posts_last_snapshot"
  ON "reddit_posts" USING btree ("last_snapshot_at")
  WHERE "deletion_detected_at" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_users_cache_last_refresh"
  ON "reddit_users_cache" USING btree ("last_metadata_refresh_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_subreddits_cache_last_refresh"
  ON "reddit_subreddits_cache" USING btree ("last_metadata_refresh_at");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reddit_post_snapshots_post_id_polled_at_uq"
  ON "reddit_post_snapshots" USING btree ("post_id", "polled_at");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reddit_user_snapshots_username_polled_at_uq"
  ON "reddit_user_snapshots" USING btree ("username", "polled_at");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reddit_subreddit_snapshots_subreddit_polled_at_uq"
  ON "reddit_subreddit_snapshots" USING btree ("subreddit", "polled_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reddit_refresh_queue_pending"
  ON "reddit_refresh_queue" USING btree ("queue_name", "status", "priority", "enqueued_at")
  WHERE "status" = 'pending';

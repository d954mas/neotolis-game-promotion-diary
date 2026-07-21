-- Phase 12-02 (D-05): CREATE the four fresh ScrapeCreators Reddit tables, paired
-- with 0070 (DROP the old free-`.json` tables). Public-data (no user_id) — subject
-- entity per kind (reddit_accounts / reddit_subreddits) + full post history
-- (reddit_posts + reddit_post_snapshots time-series). No enum migration:
-- reddit_account/reddit_subreddit (sourceKindEnum) + reddit_post (eventKindEnum)
-- already exist unchanged. ROLLBACK: forward-only — DROP the four tables to revert
-- (no data yet at deploy; the old tables are already gone via 0070).
CREATE TABLE "reddit_accounts" (
	"username" text PRIMARY KEY NOT NULL,
	"title" text,
	"icon_url" text,
	"karma" integer,
	"follower_count" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_subreddits" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text,
	"subscriber_count" integer,
	"icon_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"subreddit_slug" text,
	"media_type" text,
	"title" text,
	"caption" text,
	"permalink" text,
	"thumbnail_url" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
	"poll_failure_count" integer DEFAULT 0 NOT NULL,
	"author" text,
	"author_fullname" text,
	"deletion_detected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"like_count" bigint,
	"comment_count" bigint,
	"score" integer,
	"upvote_ratio" real,
	"num_comments" integer,
	"num_crossposts" integer,
	"removed_by_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_reddit_posts_author" ON "reddit_posts" USING btree ("author","published_at") WHERE "reddit_posts"."author" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_reddit_posts_subreddit_published" ON "reddit_posts" USING btree ("subreddit_slug","published_at");--> statement-breakpoint
CREATE INDEX "idx_reddit_posts_published_at" ON "reddit_posts" USING btree ("published_at") WHERE "reddit_posts"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_reddit_posts_permalink" ON "reddit_posts" USING btree ("permalink");--> statement-breakpoint
CREATE INDEX "idx_reddit_posts_active_poll" ON "reddit_posts" USING btree ("last_polled_at") WHERE "reddit_posts"."deletion_detected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_post_snapshots_post_polled_unq" ON "reddit_post_snapshots" USING btree ("post_id","polled_at");
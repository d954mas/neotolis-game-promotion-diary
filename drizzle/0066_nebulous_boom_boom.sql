-- Phase 11 (twitter-x-adapter) — three public-data Twitter/X tables.
-- twitter_accounts (subject entity, account_id PK) / twitter_posts (tweet_id PK,
-- the resolveCachedExternalId permalink lookup index) / twitter_post_snapshots
-- (view/like/comment/share + the D-05 raw retweet/quote/bookmark components).
-- NO enum ALTER — twitter_post (eventKindEnum) + twitter_account (sourceKindEnum)
-- already exist in the DB schema from an earlier phase.
-- Forward-only (AGENTS.md). Emergency rollback:
--   DROP TABLE twitter_post_snapshots, twitter_posts, twitter_accounts;
CREATE TABLE "twitter_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"name" text,
	"avatar_url" text,
	"follower_count" integer,
	"handle_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitter_posts" (
	"tweet_id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"media_type" text,
	"caption" text,
	"permalink" text,
	"thumbnail_url" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
	"poll_failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitter_post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tweet_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"view_count" bigint,
	"like_count" bigint,
	"comment_count" bigint,
	"share_count" bigint,
	"retweet_count" bigint,
	"quote_count" bigint,
	"bookmark_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_twitter_accounts_handle_aliases" ON "twitter_accounts" USING gin ("handle_aliases");--> statement-breakpoint
CREATE INDEX "idx_twitter_posts_published_at" ON "twitter_posts" USING btree ("published_at") WHERE "twitter_posts"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_twitter_posts_account_published_at" ON "twitter_posts" USING btree ("account_id","published_at");--> statement-breakpoint
CREATE INDEX "idx_twitter_posts_permalink" ON "twitter_posts" USING btree ("permalink");--> statement-breakpoint
CREATE UNIQUE INDEX "twitter_post_snapshots_tweet_polled_unq" ON "twitter_post_snapshots" USING btree ("tweet_id","polled_at");
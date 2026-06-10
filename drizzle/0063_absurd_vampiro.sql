-- Phase 10 Wave-0 foundation: TikTok adapter tables + enum values + the D-01
-- shared-prepaid-balance re-key (CHECKLIST §1 rollback note).
--
-- Adds: source_kind 'tiktok_account', event_kind 'tiktok_post', and the three
-- public-data tables tiktok_accounts / tiktok_posts / tiktok_post_snapshots
-- (the snapshot table carries share_count — the IG-omitted PLAT-02 metric).
-- Re-keys social_provider_balance from PK (platform, provider) to PK (provider)
-- and DROPs its platform column so Instagram + TikTok share ONE prepaid ceiling
-- per provider (RESEARCH Q1 Option (b) / CONTEXT D-01).
--
-- ROLLBACK (forward-only by AGENTS.md; emergency manual recovery only):
--   DROP TABLE tiktok_post_snapshots, tiktok_posts, tiktok_accounts;
--   ALTER TABLE social_provider_balance ADD COLUMN platform text;  -- backfill
--     from social_provider_spend before re-adding the (platform, provider) PK;
--   -- Postgres cannot DROP a single enum value: removing 'tiktok_account' /
--   -- 'tiktok_post' requires recreating the enum type. Leaving the unused enum
--   -- values in place is the safe no-op (they have no rows referencing them).
ALTER TYPE "public"."source_kind" ADD VALUE 'tiktok_account';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'tiktok_post';--> statement-breakpoint
CREATE TABLE "tiktok_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"nickname" text,
	"avatar_url" text,
	"follower_count" integer,
	"sec_uid" text,
	"handle_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tiktok_posts" (
	"aweme_id" text PRIMARY KEY NOT NULL,
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
CREATE TABLE "tiktok_post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"aweme_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"view_count" bigint,
	"like_count" bigint,
	"comment_count" bigint,
	"share_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_provider_balance" DROP CONSTRAINT "social_provider_balance_platform_provider_pk";--> statement-breakpoint
ALTER TABLE "social_provider_balance" ADD CONSTRAINT "social_provider_balance_provider_pk" PRIMARY KEY("provider");--> statement-breakpoint
CREATE INDEX "idx_tiktok_accounts_handle_aliases" ON "tiktok_accounts" USING gin ("handle_aliases");--> statement-breakpoint
CREATE INDEX "idx_tiktok_posts_published_at" ON "tiktok_posts" USING btree ("published_at") WHERE "tiktok_posts"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_post_snapshots_aweme_polled_unq" ON "tiktok_post_snapshots" USING btree ("aweme_id","polled_at");--> statement-breakpoint
ALTER TABLE "social_provider_balance" DROP COLUMN "platform";
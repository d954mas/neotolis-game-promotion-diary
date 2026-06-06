CREATE TABLE "instagram_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
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
CREATE TABLE "instagram_post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"view_count" bigint,
	"like_count" bigint,
	"comment_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_provider_balance" (
	"platform" text NOT NULL,
	"provider" text NOT NULL,
	"prepaid_balance_credits" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_provider_balance_platform_provider_pk" PRIMARY KEY("platform","provider")
);
--> statement-breakpoint
CREATE TABLE "social_provider_spend" (
	"date_pacific" date NOT NULL,
	"platform" text NOT NULL,
	"provider" text NOT NULL,
	"pool_kind" text NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_provider_spend_date_pacific_platform_provider_pool_kind_pk" PRIMARY KEY("date_pacific","platform","provider","pool_kind")
);
--> statement-breakpoint
CREATE INDEX "idx_instagram_posts_published_at" ON "instagram_posts" USING btree ("published_at") WHERE "instagram_posts"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_post_snapshots_post_polled_unq" ON "instagram_post_snapshots" USING btree ("post_id","polled_at");
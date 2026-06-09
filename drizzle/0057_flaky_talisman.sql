CREATE TABLE "telegram_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"channel_key" text,
	"text_snippet" text,
	"media_kind" text,
	"thumbnail_url" text,
	"external_url" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" text,
	"poll_failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_post_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"view_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_pacer" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"next_allowed_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"paused_until" timestamp with time zone,
	"pause_level" smallint DEFAULT 0 NOT NULL,
	"last_pause_reason" text,
	"last_paused_at" timestamp with time zone,
	CONSTRAINT "telegram_pacer_last_pause_reason_check" CHECK ("telegram_pacer"."last_pause_reason" IS NULL OR "telegram_pacer"."last_pause_reason" IN ('http_403', 'http_429'))
);
--> statement-breakpoint
CREATE INDEX "idx_telegram_posts_published_at" ON "telegram_posts" USING btree ("published_at") WHERE "telegram_posts"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_post_snapshots_post_polled_unq" ON "telegram_post_snapshots" USING btree ("post_id","polled_at");--> statement-breakpoint
-- Seed the singleton pacer row (id=1). drizzle-kit generate does not emit
-- data, so this is added by hand — matching the reddit_pacer migration. The
-- application code never INSERTs / DELETEs this row; it only atomically reads +
-- bumps next_allowed_at. ON CONFLICT DO NOTHING makes the seed idempotent.
INSERT INTO "telegram_pacer" ("id", "next_allowed_at")
VALUES (1, NOW())
ON CONFLICT ("id") DO NOTHING;
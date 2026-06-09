-- Phase 9 — telegram_channels: the Telegram channel subject entity (public-data,
-- source-of-truth for a channel's own scraped upstream metadata; PK = the
-- rename-proof numeric channel id from each post's data-view payload). See
-- src/lib/sources/telegram/server/schema/channels.ts for the full rationale.
--
-- Forward-only (AGENTS.md). Emergency rollback (additive table, no data
-- backfilled into existing rows — safe to drop):
--   DROP INDEX IF EXISTS "idx_telegram_channels_handle_aliases";
--   DROP TABLE IF EXISTS "telegram_channels";
CREATE TABLE "telegram_channels" (
	"channel_key" text PRIMARY KEY NOT NULL,
	"slug" text,
	"title" text,
	"avatar_url" text,
	"description" text,
	"subscriber_count" integer,
	"handle_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_telegram_channels_handle_aliases" ON "telegram_channels" USING gin ("handle_aliases");
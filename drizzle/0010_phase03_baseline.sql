-- Phase 3.0 Plan 01 baseline: polling-pipeline-plumbing-youtube schema additions.
--
-- Forward-only; no down migration; runs under the advisory lock per
-- src/lib/server/db/migrate.ts (D-23). Three public-data tables (no user_id
-- columns — D-07 / D-13 / D-14), two new partial indexes on events, five new
-- audit_action enum verbs, and a pgboss legacy-queue cleanup. The ALTER TYPE
-- ADD VALUE statements use IF NOT EXISTS for idempotency (Plan 02.1-12 /
-- 02.1-27 / 02.2-01 precedent — Postgres 16 ALTER TYPE rules forbid running
-- inside a multi-statement transaction with other DDL, so each verb is its
-- own statement-breakpoint and re-runs cleanly).

ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'quota.service_throttled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'purge.completed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'auto_import.deferred';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'poll.failed';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'event.poll_refreshed';--> statement-breakpoint
CREATE TABLE "youtube_channel_metadata_cache" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"uploads_playlist_id" text NOT NULL,
	"channel_title" text,
	"last_backfill_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_service_quota_usage" (
	"date_pacific" date NOT NULL,
	"api_key_id" text NOT NULL,
	"estimated_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "youtube_service_quota_usage_date_pacific_api_key_id_pk" PRIMARY KEY("date_pacific","api_key_id")
);
--> statement-breakpoint
CREATE TABLE "youtube_video_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"view_count" bigint,
	"like_count" bigint,
	"comment_count" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "youtube_video_snapshots_video_id_polled_at_idx" ON "youtube_video_snapshots" USING btree ("video_id","polled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_video_snapshots_video_polled_unq" ON "youtube_video_snapshots" USING btree ("video_id","polled_at");--> statement-breakpoint
CREATE INDEX "idx_events_last_polled_at" ON "events" USING btree ("last_polled_at") WHERE "events"."last_polled_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_user_kind_ext_active_unq" ON "events" USING btree ("user_id","kind","external_id") WHERE "events"."external_id" IS NOT NULL AND "events"."deleted_at" IS NULL;--> statement-breakpoint
-- Phase 3.0 Plan 01 — pgboss queue cleanup (drop renamed/retired queues from
-- prior phases). Phase 1 declared `poll.hot` + `poll.warm` as a forward-compat
-- scaffold but no jobs ever ran against them; DV-2 collapses the 4-tier model
-- into 3-tier so `poll.hot` is renamed to `poll.active` and `poll.warm` is
-- dropped entirely. The pgboss schema is created at runtime by `boss.start()`,
-- not at migrate time, so this DELETE is gated on schema existence to keep
-- the migration safe on fresh test DBs (where pgboss has not yet booted).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'queue') THEN
    DELETE FROM pgboss.queue WHERE name IN ('poll.hot', 'poll.warm');
  END IF;
END $$;

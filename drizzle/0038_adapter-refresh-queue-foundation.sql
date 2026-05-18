CREATE TABLE IF NOT EXISTS "adapter_refresh_queue" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "adapter_kind" text NOT NULL,
  "queue_name" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "user_id" text,
  "priority" smallint NOT NULL,
  "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  CONSTRAINT "adapter_refresh_queue_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);--> statement-breakpoint

ALTER TABLE "adapter_refresh_queue"
  ADD CONSTRAINT "adapter_refresh_queue_status_check"
  CHECK ("status" IN ('pending', 'processing', 'done', 'dead_letter'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_adapter_refresh_queue_pending"
  ON "adapter_refresh_queue" USING btree
  ("adapter_kind", "queue_name", "status", "priority", "next_attempt_at", "enqueued_at")
  WHERE "status" = 'pending';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_adapter_refresh_queue_processing_last_attempt"
  ON "adapter_refresh_queue" USING btree ("adapter_kind", "status", "last_attempt_at")
  WHERE "status" = 'processing';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_adapter_refresh_queue_user_window"
  ON "adapter_refresh_queue" USING btree
  ("adapter_kind", "user_id", "queue_name", "enqueued_at");--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reddit_pacer_last_pause_reason_check'
  ) THEN
    ALTER TABLE "reddit_pacer"
      ADD CONSTRAINT "reddit_pacer_last_pause_reason_check"
      CHECK ("last_pause_reason" IS NULL OR "last_pause_reason" IN ('http_403', 'http_429'));
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.reddit_refresh_queue') IS NOT NULL THEN
    INSERT INTO "adapter_refresh_queue" (
      "adapter_kind",
      "queue_name",
      "type",
      "payload",
      "user_id",
      "priority",
      "enqueued_at",
      "attempts",
      "last_attempt_at",
      "next_attempt_at",
      "status"
    )
    SELECT
      'reddit_account',
      "queue_name",
      "type",
      "payload",
      "user_id",
      "priority",
      "enqueued_at",
      "attempts",
      "last_attempt_at",
      "next_attempt_at",
      "status"
    FROM "reddit_refresh_queue"
    WHERE "status" IN ('pending', 'processing', 'done', 'dead_letter');
  END IF;
END $$;--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.youtube_refresh_queue') IS NOT NULL THEN
    INSERT INTO "adapter_refresh_queue" (
      "adapter_kind",
      "queue_name",
      "type",
      "payload",
      "user_id",
      "priority",
      "enqueued_at",
      "attempts",
      "last_attempt_at",
      "next_attempt_at",
      "status"
    )
    SELECT
      'youtube_channel',
      "queue_name",
      "type",
      "payload",
      "user_id",
      "priority",
      "enqueued_at",
      "attempts",
      "last_attempt_at",
      "next_attempt_at",
      "status"
    FROM "youtube_refresh_queue"
    WHERE "status" IN ('pending', 'processing', 'done', 'dead_letter');
  END IF;
END $$;--> statement-breakpoint

-- Replace adapter-specific runtime queues after preserving any in-flight
-- rows in adapter_refresh_queue. The new shared table owns lifecycle from
-- this migration forward.
DROP TABLE IF EXISTS "reddit_refresh_queue";--> statement-breakpoint
DROP TABLE IF EXISTS "youtube_refresh_queue";

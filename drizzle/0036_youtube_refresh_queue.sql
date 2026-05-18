-- YouTube video stats SQL queue.
--
-- User-driven and service-driven stats refresh paths both burn YouTube
-- quota. A SQL queue gives each requested video its own status/attempt
-- lifecycle while the worker can still claim up to 50 rows for one
-- videos.list call. App-level per-user quota is enforced before enqueue
-- and recorded in audit_log; service rows run under the cron pool.

CREATE TABLE IF NOT EXISTS "youtube_refresh_queue" (
  "id" bigserial PRIMARY KEY NOT NULL,
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
  CONSTRAINT "youtube_refresh_queue_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE
);--> statement-breakpoint

ALTER TABLE "youtube_refresh_queue"
  ADD CONSTRAINT "youtube_refresh_queue_queue_name_check"
  CHECK ("queue_name" IN ('user_video', 'service_video'));--> statement-breakpoint

ALTER TABLE "youtube_refresh_queue"
  ADD CONSTRAINT "youtube_refresh_queue_type_check"
  CHECK ("type" IN ('video_stats'));--> statement-breakpoint

ALTER TABLE "youtube_refresh_queue"
  ADD CONSTRAINT "youtube_refresh_queue_status_check"
  CHECK ("status" IN ('pending', 'processing', 'done', 'dead_letter'));--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_youtube_refresh_queue_pending"
  ON "youtube_refresh_queue" USING btree ("queue_name", "status", "priority", "next_attempt_at", "enqueued_at")
  WHERE "status" = 'pending';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_youtube_refresh_queue_processing_last_attempt"
  ON "youtube_refresh_queue" USING btree ("last_attempt_at")
  WHERE "status" = 'processing';

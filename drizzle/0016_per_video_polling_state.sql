-- Phase 3.0 post-build refactor (2026-05-06) — move polling state from
-- per-event copies on `events` to per-video columns on `youtube_videos`.
--
-- Rationale: tier classification (Active/Cold/Frozen) is a property of the
-- VIDEO (its publishedAt), not of the user-logged event. Multiple events
-- referencing one video shared identical last_polled_at copies in the old
-- model — wasteful and a source of drift. Single source of truth on
-- `youtube_videos` lets the scheduler dedup by video_id (one HTTP call
-- per video per tier-tick instead of per-event), tier-resolves correctly,
-- and the rehab-unavailable cron has a clean failure-count gate.
--
-- See PROJECT.md "Architecture" section for the per-video polling model.
-- Forward-only — no down migration.

-- Drop the index on events.last_polled_at BEFORE dropping the column.
DROP INDEX IF EXISTS "idx_events_last_polled_at";--> statement-breakpoint

-- Add columns to youtube_videos. NULL last_polled_at on a fresh row signals
-- the 'pending' tier (channel-context-backfill has not run yet).
-- poll_failure_count drives the rehab cron's exit gate at >= 5.
ALTER TABLE "youtube_videos" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "youtube_videos" ADD COLUMN "last_poll_status" text;--> statement-breakpoint
ALTER TABLE "youtube_videos" ADD COLUMN "poll_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Scheduler tier filter — published_at narrows the SELECT before the JOIN
-- back to events. Partial index keeps it cheap over the rare null-published
-- rows (videos pre-backfill, the 'pending' tier).
CREATE INDEX "idx_youtube_videos_published_at" ON "youtube_videos" USING btree ("published_at") WHERE "published_at" IS NOT NULL;--> statement-breakpoint

-- Rehab cron — weekly walks 'not_found' / 'private' videos with
-- poll_failure_count < 5. Partial index narrows to the actual target set
-- so the cron's SELECT stays cheap as the cache grows.
CREATE INDEX "idx_youtube_videos_rehab" ON "youtube_videos" USING btree ("last_polled_at") WHERE "last_poll_status" IN ('not_found', 'private') AND "poll_failure_count" < 5;--> statement-breakpoint

-- Defense for dev DBs that already have polling data on events from UAT
-- runs of Phase 3.0. On prod (Phase 2.2 ship 2026-05-04) `last_polled_at`
-- is always NULL on events — Phase 2.2 introduced the column but never
-- wrote to it — so the INSERT/UPDATE pair below is a no-op there.
--
-- Step 1: ensure youtube_videos rows exist for every external_id referenced
-- by an events row. Phase 3.0's ingest path enqueues channel-context-backfill
-- which seeds these rows, but a UAT-paused job could leave gaps.
INSERT INTO "youtube_videos" ("video_id", "title", "fetched_at")
SELECT DISTINCT e."external_id", e."title", NOW()
FROM "events" e
WHERE e."kind" = 'youtube_video'
  AND e."external_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "youtube_videos" yv WHERE yv."video_id" = e."external_id")
ON CONFLICT ("video_id") DO NOTHING;--> statement-breakpoint

-- Step 2: aggregate per-event polling state into per-video columns. Two
-- users could in theory have different statuses for the same external_id
-- in the old model (race window during status update); we resolve by
-- recency — the most recently polled event's status wins. poll_failure_count
-- starts at 1 if the carried-over status is non-ok, 0 otherwise; further
-- polls will refine it.
UPDATE "youtube_videos" yv SET
  "last_polled_at" = sub.max_polled_at,
  "last_poll_status" = sub.recent_status,
  "poll_failure_count" = CASE
    WHEN sub.recent_status IS NULL OR sub.recent_status = 'ok' THEN 0
    ELSE 1
  END
FROM (
  SELECT
    e."external_id" AS external_id,
    MAX(e."last_polled_at") AS max_polled_at,
    (SELECT e2."last_poll_status"
     FROM "events" e2
     WHERE e2."external_id" = e."external_id"
       AND e2."kind" = 'youtube_video'
       AND e2."last_polled_at" IS NOT NULL
     ORDER BY e2."last_polled_at" DESC
     LIMIT 1) AS recent_status
  FROM "events" e
  WHERE e."kind" = 'youtube_video'
    AND e."external_id" IS NOT NULL
    AND e."last_polled_at" IS NOT NULL
  GROUP BY e."external_id"
) sub
WHERE yv."video_id" = sub.external_id;--> statement-breakpoint

-- Drop the polling columns from events. Data is now on youtube_videos.
ALTER TABLE "events" DROP COLUMN "last_polled_at";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "last_poll_status";

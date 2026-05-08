-- Phase 3.0 post-build review (2026-05-07) — close the
-- /api/youtube/fetch-metadata operator-quota burn loop.
--
-- Background: ingest's "Get from YouTube" button on /events/new calls
-- fetchVideoMetadataByUrl. Cache hit (videoId already in youtube_videos)
-- → zero quota. Cache miss → 1 quota unit on the operator's key. The
-- route is auth-gated (tenantScope) but per-user rate-limited only by
-- the FALSE comment "events_per_day is the cap" — events_per_day counts
-- rows in the events table, which a metadata-fetch never touches, so
-- the gate never triggered. A scripted-loop with random video ids
-- could drain the operator's full 10,000 unit/day envelope, breaking
-- polling / auto-import for every other tenant on a SaaS deploy.
--
-- Fix: a per-user rolling 24h counter for cache-miss metadata fetches.
-- A new dedicated table avoids piggy-backing on events_per_day — the
-- two operations have different threat models (event creates vs.
-- pre-event-form metadata pulls). 50/day default cap matches the
-- existing per-user rate caps; operators can raise via env.
--
-- Forward-only. user_id FK with ON DELETE CASCADE so purgeAccount
-- sweep clears the row on account purge (the cascade already covers
-- this without needing a manual entry in services/purge-account.ts).

CREATE TABLE "youtube_metadata_fetch_log" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- (user_id, fetched_at DESC) covers both the rolling-24h count and the
-- "most recent N for this user" pattern. Partial WHERE keeps the index
-- narrow over the rolling window.
CREATE INDEX "idx_youtube_metadata_fetch_log_user_at"
  ON "youtube_metadata_fetch_log" ("user_id", "fetched_at" DESC);

-- Phase 3.0 post-build refactor (2026-05-07) — close the handle-URL cache
-- miss permanently.
--
-- Background: ingest's enqueue path uses the extracted channel id as the
-- pg-boss singletonKey AND the youtube_channels cache lookup key. For
-- /channel/UC… URLs this works perfectly — the UC id is the table PK so
-- repeat-paste hits the cache, zero quota burn. For /@handle / /c/legacy
-- URLs the extracted id is the raw URL string, which never matches the
-- table PK (the row is keyed under the resolved UC id by the backfill
-- worker). Repeat-paste of the same handle URL would re-enqueue the
-- backfill on every singleton-window expiry — bug-3 in the post-build
-- code review (mitigated earlier with a 30-day singleton bump,
-- closed properly here).
--
-- Fix: track every handle URL that resolves to a given UC id in a
-- handle_aliases TEXT[] column. The backfill worker, after resolving
-- forHandle → UC, appends the input handle URL to the array on the
-- existing row. Ingest's cache lookup widens with OR $key = ANY(handle_
-- aliases) so any subsequent paste of the same handle URL hits the
-- cache permanently — no enqueue, no quota.
--
-- Forward-only. Default '{}' so existing rows participate immediately
-- (empty array means "no aliases recorded yet"; future paste from a
-- handle URL appends the alias to the existing UC row).

ALTER TABLE "youtube_channels"
  ADD COLUMN "handle_aliases" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint

-- GIN index supports the `= ANY(handle_aliases)` cache lookup pattern
-- in ingest. Postgres can answer the membership check without a seq
-- scan even at scale (every operator's worth of channels = thousands
-- of rows, not millions, but the GIN cost is trivial and the index
-- shape matches the natural query).
CREATE INDEX "idx_youtube_channels_handle_aliases"
  ON "youtube_channels" USING GIN ("handle_aliases");

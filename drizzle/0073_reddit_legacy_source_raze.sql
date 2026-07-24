-- Phase 12 review fix — extends the D-05 raze (0070) to the LEGACY Reddit
-- data_sources rows the razed free-`.json` adapter created. Their metadata carries
-- the OLD walk keys ({username}/{subreddit}); the rebuilt walker reads
-- {handle}/{slug}, so a retained row would resolve a garbage channelKey (its own
-- row UUID), burn a credit on an empty author-search and flag needs_reconnect
-- forever. Operator call (2026-07-22): raze the rows — users re-add their Reddit
-- sources. Diary events SURVIVE: events.source_id is ON DELETE SET NULL, so the
-- rows detach and render like manual pastes (feed enrichment re-hydrates once the
-- rebuilt walker re-caches the posts).
-- The channel-state bookkeeping dies with the sources: a stale
-- backfill_complete / frontier written by the razed walker must not leak into the
-- rebuilt walker's exhausted/incremental branch math.
UPDATE "events"
SET "metadata" = COALESCE("events"."metadata", '{}'::jsonb)
  || '{"reddit_legacy_source_detached":true}'::jsonb
WHERE "source_id" IN (
  SELECT "id" FROM "data_sources"
  WHERE "kind"::text IN ('reddit_account', 'reddit_subreddit')
)
AND "kind"::text = 'reddit_post';--> statement-breakpoint
DELETE FROM "data_sources" WHERE "kind"::text IN ('reddit_account', 'reddit_subreddit');--> statement-breakpoint
DELETE FROM "data_source_channel_state" WHERE "kind"::text IN ('reddit_account', 'reddit_subreddit');

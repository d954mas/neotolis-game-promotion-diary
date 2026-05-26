-- Forward-only data migration: unify metadata.triage off-topic field name.
-- Plan 03.4-10 unblocks the bug where bulkEdit wrote `triage.offTopic` while
-- the feed filter (listFeedPage) + markStandalone/unmarkStandalone read
-- `triage.standalone`. The two paths targeted different JSONB keys, so
-- off-topic toggles via GamesPicker were invisible to the filter.
--
-- Step 1: copy any existing `triage.standalone` value to `triage.offTopic`
-- (only when the source key exists). Idempotent per row — re-running on an
-- already-migrated row is a no-op (the WHERE filter drops it).
-- Step 2: drop the legacy `triage.standalone` key. Idempotent — only fires
-- when the key still exists.
--
-- No schema column change. Snapshot stays unchanged; only data shape moves.
UPDATE events
SET metadata = jsonb_set(
  metadata,
  '{triage,offTopic}',
  metadata->'triage'->'standalone',
  true
)
WHERE metadata->'triage' ? 'standalone';
--> statement-breakpoint
UPDATE events
SET metadata = metadata #- '{triage,standalone}'
WHERE metadata->'triage' ? 'standalone';

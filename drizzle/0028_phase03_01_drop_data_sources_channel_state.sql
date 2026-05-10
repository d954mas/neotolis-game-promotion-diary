-- Phase 03.0.1 Wave 4 — drop per-source channel-state columns from
-- data_sources. Replaced by data_source_channel_state (one row per
-- channel, shared across subscribers — see migration 0027).
--
-- Order:
--   1. Drop the partial index that referenced the columns.
--   2. Drop the columns.
--   3. Strip lastBackfillPageToken from data_sources.metadata jsonb
--      (data lives in channel state's metadata now).
--
-- Forward-only. After Wave 1's backfill (migration 0027), per-source
-- state is still authoritatively in data_sources but unused; Wave 2-3
-- worker code already writes channel state directly. Wave 4 code paths
-- (this commit) read channel state and no longer reference these columns.
-- Dropping them is the final step of the per-source → channel-scoped
-- transition.
--
-- ROLLBACK (forward-only by AGENTS.md, but documented for emergency):
--   ALTER TABLE data_sources ADD COLUMN last_polled_at timestamp with time zone;
--   ALTER TABLE data_sources ADD COLUMN backfill_oldest_at timestamp with time zone;
--   ALTER TABLE data_sources ADD COLUMN backfill_complete boolean NOT NULL DEFAULT false;
--   CREATE INDEX data_sources_backfill_picker_idx
--     ON data_sources (user_id, last_polled_at)
--     WHERE backfill_complete = false AND deleted_at IS NULL;
--   -- Backfill from channel state:
--   UPDATE data_sources ds SET
--     last_polled_at = cs.last_polled_at,
--     backfill_oldest_at = cs.backfill_oldest_at,
--     backfill_complete = cs.backfill_complete
--   FROM data_source_channel_state cs
--   WHERE ds.kind = cs.kind AND ds.channel_id = cs.channel_key;

DROP INDEX IF EXISTS data_sources_backfill_picker_idx;

ALTER TABLE data_sources DROP COLUMN IF EXISTS last_polled_at;
ALTER TABLE data_sources DROP COLUMN IF EXISTS backfill_oldest_at;
ALTER TABLE data_sources DROP COLUMN IF EXISTS backfill_complete;

UPDATE data_sources
SET metadata = metadata - 'lastBackfillPageToken'
WHERE metadata ? 'lastBackfillPageToken';

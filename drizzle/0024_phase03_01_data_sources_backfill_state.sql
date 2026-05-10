-- Phase 03.0.1 — Backfill state machine for data_sources.
--
-- ROLLBACK (forward-only by AGENTS.md, but documented for emergency):
--   ALTER TABLE data_sources DROP COLUMN last_polled_at;
--   ALTER TABLE data_sources DROP COLUMN backfill_oldest_at;
--   ALTER TABLE data_sources DROP COLUMN backfill_complete;
--   ALTER TABLE data_sources DROP COLUMN backfill_target_since;
--   DROP INDEX IF EXISTS data_sources_backfill_picker_idx;
-- Application code reading these columns must also revert (worker handlers,
-- DTO projections, refresh-content endpoint). v0.1 prod data is unaffected
-- by drop — columns are application-state, not domain-data.
--
-- Forward-only. Adds four columns to track per-source backfill progress:
--
--   last_polled_at        — when we last successfully ran a backfill action
--                           (any kind: initial setup, user-triggered refresh,
--                           per-event stats refresh, auto-passive cron pick).
--                           UI displays "обновлено N часов назад".
--
--   backfill_oldest_at    — frontier marker — earliest event.occurred_at we've
--                           successfully pulled via auto-import flows. Resume
--                           boundary for "pull older" semantics. NULL until
--                           the first successful auto-import insertion.
--
--   backfill_complete     — true when adapter.pollContent returned an empty
--                           HTTP-200 success page (platform API явно подтвердил
--                           "no more older content"). User refresh resets
--                           this to false (trust-but-verify) for re-check.
--
--   backfill_target_since — absolute date — earliest event boundary the user
--                           wants pulled. Worker passes directly to
--                           adapter.pollContent(source, since). Sentinel
--                           1970-01-01T00:00:00Z = "all available history".
--
-- v0.1 was deployed to prod 2026-05-04. Adding nullable / default columns is
-- safe on populated tables — Postgres backfills atomically and the migration
-- runner under advisory lock (src/lib/server/db/migrate.ts) prevents
-- concurrent boots from racing the ALTER.
--
-- The UPDATE backfills `backfill_target_since` for existing rows by translating
-- their `metadata.backfillWindow` preset string to an absolute date. After this
-- migration, all rows have a non-null `backfill_target_since`; new rows will
-- be populated by app-level createSource / updateSource code. The
-- `metadata.backfillWindow` field is deprecated — `backfill_target_since` is
-- the single source of truth.

ALTER TABLE data_sources
  ADD COLUMN last_polled_at timestamp with time zone;

ALTER TABLE data_sources
  ADD COLUMN backfill_oldest_at timestamp with time zone;

ALTER TABLE data_sources
  ADD COLUMN backfill_complete boolean NOT NULL DEFAULT false;

ALTER TABLE data_sources
  ADD COLUMN backfill_target_since timestamp with time zone;

-- Migrate existing rows: derive absolute date from metadata.backfillWindow preset.
-- Rows without the preset (legacy or non-functional kinds) get the 30d default.
UPDATE data_sources
SET backfill_target_since = CASE
  WHEN metadata->>'backfillWindow' = '1d'         THEN NOW() - INTERVAL '1 day'
  WHEN metadata->>'backfillWindow' = '7d'         THEN NOW() - INTERVAL '7 days'
  WHEN metadata->>'backfillWindow' = '30d'        THEN NOW() - INTERVAL '30 days'
  WHEN metadata->>'backfillWindow' = '90d'        THEN NOW() - INTERVAL '90 days'
  WHEN metadata->>'backfillWindow' = '1y'         THEN NOW() - INTERVAL '1 year'
  WHEN metadata->>'backfillWindow' = 'everything' THEN '1970-01-01 00:00:00+00'::timestamp with time zone
  ELSE NOW() - INTERVAL '30 days'
END
WHERE backfill_target_since IS NULL;

-- Index for auto-backfill cron picker (SELECT incomplete sources ORDER BY user_id, last_polled_at).
CREATE INDEX IF NOT EXISTS data_sources_backfill_picker_idx
  ON data_sources (user_id, last_polled_at)
  WHERE backfill_complete = false AND deleted_at IS NULL;

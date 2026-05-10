-- Phase 03.0.1 Wave 1 — channel-scoped polling foundation.
--
-- Creates `data_source_channel_state` (one row per kind+channel_key, shared
-- across all subscribers to the same channel) and backfills it from the
-- existing per-source state in `data_sources`. This migration is ADDITIVE —
-- old columns in data_sources stay populated until Wave 4 drops them, so
-- old worker code can keep running through Waves 2-3 transition.
--
-- Why: previously 10 users subscribed to the same YouTube channel triggered
-- 10 separate playlistItems.list walks per cron tick (10× quota burn for
-- identical data). Channel-scoped state allows a single walk per channel
-- per tick, fanning out events to all subscribers. Triggering user pays
-- quota; subscribers free-ride.
--
-- Backfill aggregation rules across all subscribers per channel:
--   last_polled_at      — MAX (most recent across any user's poll)
--   backfill_oldest_at  — MIN (deepest frontier any user reached)
--   backfill_complete   — bool_or (any user reaching endOfPlaylist applies
--                         to all — same upstream playlist)
--   metadata            — first non-null lastBackfillPageToken (resume cursor
--                         is channel-level; if multiple users had cursors,
--                         pick any — they all point at the same playlist)
--
-- v0.1 prod data uses backfill_complete=false default; aggregation handles
-- the cold-start case. New subscribers added after this migration will use
-- the channel state directly, no per-source backfill columns set.
--
-- Tenant scoping: this table is intentionally CROSS-TENANT (channels are
-- global). Tenant scoping happens at INSERT-into-events fan-out time —
-- each subscriber's user_id row in events is the tenant boundary, not the
-- channel state. The application database role's grants are unchanged
-- (no UPDATE/DELETE on audit_log invariant unaffected).
--
-- ROLLBACK (forward-only by AGENTS.md, but documented for emergency):
--   DROP TABLE data_source_channel_state;
-- Worker handlers must be reverted to pre-Wave-2 in lockstep.

CREATE TABLE data_source_channel_state (
  kind source_kind NOT NULL,
  channel_key text NOT NULL,
  last_polled_at timestamp with time zone,
  backfill_oldest_at timestamp with time zone,
  backfill_complete boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, channel_key)
);

CREATE INDEX data_source_channel_state_picker_idx
  ON data_source_channel_state (last_polled_at)
  WHERE backfill_complete = false;

-- Backfill from data_sources. WHERE channel_id IS NOT NULL filters out
-- sources that never resolved a canonical id (rare transient state during
-- onboarding) — those will get a channel_state row on their first walk.
INSERT INTO data_source_channel_state (
  kind, channel_key, last_polled_at, backfill_oldest_at, backfill_complete, metadata
)
SELECT
  ds.kind,
  ds.channel_id AS channel_key,
  MAX(ds.last_polled_at) AS last_polled_at,
  MIN(ds.backfill_oldest_at) AS backfill_oldest_at,
  bool_or(ds.backfill_complete) AS backfill_complete,
  COALESCE(
    (
      SELECT jsonb_build_object('lastBackfillPageToken', d2.metadata->>'lastBackfillPageToken')
      FROM data_sources d2
      WHERE d2.kind = ds.kind
        AND d2.channel_id = ds.channel_id
        AND d2.metadata ? 'lastBackfillPageToken'
        AND d2.deleted_at IS NULL
      LIMIT 1
    ),
    '{}'::jsonb
  ) AS metadata
FROM data_sources ds
WHERE ds.channel_id IS NOT NULL
  AND ds.deleted_at IS NULL
GROUP BY ds.kind, ds.channel_id;

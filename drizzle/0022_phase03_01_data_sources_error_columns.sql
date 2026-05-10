-- Phase 03.0.1 Plan 08 — D-13 schema additions for AdapterError surface.
-- Forward-only. New columns are NULL/FALSE-default so existing rows are
-- unaffected.
--
-- Worker handlers update these on AdapterError of category operator-issue /
-- permanent / not-found:
--   needs_reconnect — boolean banner flag on /sources/[id] when the operator
--                     must re-paste credentials (operator-issue) or the source
--                     is permanently unavailable (permanent). Reset to false
--                     by future operator action (e.g. PATCH /api/sources/:id
--                     when credentials are refreshed). v0.1 sets only true; the
--                     reset path lands in Phase 6+ alongside per-user creds.
--   last_error_at   — timestamp of the most recent AdapterError. Drives the
--                     /sources/[id] "Last error: <relative time>" badge.
--   last_error_kind — one of 'rate-limited' | 'not-found' | 'permanent' |
--                     'operator-issue'. Mirrors the AdapterError taxonomy
--                     (5th category 'transient' is NEVER persisted —
--                     transient errors retry via pg-boss and never touch
--                     this column).
--
-- v0.1 was deployed to prod 2026-05-04 with shipped data_sources rows. Adding
-- columns with NOT NULL DEFAULT false / nullable timestamp / nullable text is
-- safe on populated tables — Postgres backfills default values atomically and
-- the migration runner under advisory lock (src/lib/server/db/migrate.ts)
-- prevents concurrent boots from racing the ALTER.

ALTER TABLE data_sources
  ADD COLUMN needs_reconnect boolean NOT NULL DEFAULT false;

ALTER TABLE data_sources
  ADD COLUMN last_error_at timestamp with time zone;

ALTER TABLE data_sources
  ADD COLUMN last_error_kind text;

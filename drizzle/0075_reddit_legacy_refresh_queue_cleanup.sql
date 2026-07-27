-- Phase 12 review fix — purge stale service-lane rows left by the razed free-`.json`
-- Reddit adapter. The queue survives 0070 because it has no FK to the dropped cache
-- tables; those rows reference handlers that no longer exist and would fail forever.
--
-- DESTRUCTIVE DATA MIGRATION, EXPLICITLY APPROVED BY THE PROJECT OWNER
-- (2026-07-27, Codex review-fix task: "Исправляй"). ROLLBACK requires restoring the
-- removed queue rows from backup, but they must not be replayed against the rebuilt
-- adapter. Scope is exactly adapter_kind='reddit_account'; other adapters are untouched.
--
-- HAND-WRITTEN ON PURPOSE: drizzle-kit cannot express data cleanup. Pure DML, no schema
-- changes. The predicate is idempotent, and the real SQL file is exercised by
-- tests/integration/reddit-legacy-refresh-queue-migration.test.ts.
DELETE FROM "adapter_refresh_queue"
 WHERE "adapter_kind" = 'reddit_account';

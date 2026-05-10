-- Phase 03.0.1 (post-review #5) — split quota usage by pool kind so worker-
-- crash reconciliation can debit each in-memory reservoir accurately.
--
-- ROLLBACK (forward-only by AGENTS.md, but documented for emergency):
--   ALTER TABLE youtube_service_quota_usage
--     DROP CONSTRAINT youtube_service_quota_usage_date_pacific_api_key_id_pool_kind_pk;
--   -- Aggregate (date_pacific, api_key_id) rows back to single per-key
--   -- before re-adding original PK — needed if multiple pool_kind rows
--   -- exist for the same (date, key):
--   --   INSERT INTO youtube_service_quota_usage_tmp
--   --   SELECT date_pacific, api_key_id, SUM(estimated_units), MAX(updated_at)
--   --   FROM youtube_service_quota_usage GROUP BY date_pacific, api_key_id;
--   ALTER TABLE youtube_service_quota_usage DROP COLUMN pool_kind;
--   ALTER TABLE youtube_service_quota_usage
--     ADD CONSTRAINT youtube_service_quota_usage_date_pacific_api_key_id_pk
--     PRIMARY KEY (date_pacific, api_key_id);
-- Application code (chargedFetch, incrementUsage, writeSnapshot,
-- reconcileReservoirsOnBoot, getThrottleState, getDailyStats) must also
-- revert to single-row-per-key shape. v0.1 prod rows pre-Phase-03.0.1
-- ship as pool_kind='cron' so revert-without-aggregation is safe IF only
-- legacy rows exist (no Phase 03.0.1 user-pool entries yet).
--
-- Pre-fix: `youtube_service_quota_usage` tracked one row per
-- (date_pacific, api_key_id) with TOTAL units burned that day. Reservoirs
-- (cron 80% / user 20%) are in-memory (RateLimiterMemory) so they reset on
-- worker restart. `reconcileReservoirsOnBoot` read total today's usage and
-- dumped ALL of it into the cron reservoir — user reservoir stayed full.
-- After a mid-day crash, user pool effectively reset to its full daily
-- allowance even though some had been spent. Result: under-counted user-
-- pool consumption → over-allow on user-driven actions.
--
-- Fix: add `pool_kind` discriminator to the composite PK so each row records
-- which reservoir burned the units. Reconcile reads per-pool sums and
-- debits each reservoir accurately.
--
-- Forward-only. Existing rows had no pool attribution; we backfill them as
-- 'cron' because pre-Phase-03.0.1 the chargedFetch wrapper landed in
-- cron-context call sites first (Plan 03/04 active/cold poll, channel-
-- context-backfill). User-pool consumers (refresh-now poll-user) shipped
-- later — backfilling existing rows as 'cron' is the safe over-attribution.
--
-- v0.1 production rows keep their estimatedUnits attributed to 'cron' after
-- migration. New rows route correctly via the updated incrementUsage(args)
-- signature.

-- 1. Add new column with default 'cron' so existing rows aren't NULL.
ALTER TABLE youtube_service_quota_usage
  ADD COLUMN pool_kind text NOT NULL DEFAULT 'cron'
  CHECK (pool_kind IN ('cron', 'user'));

-- 2. Drop the old composite PK (drizzle-generated name) and add the new one
-- including pool_kind. The original PK was named by drizzle's `primaryKey`
-- helper which suffixes with column names — verify via:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid='youtube_service_quota_usage'::regclass AND contype='p';
ALTER TABLE youtube_service_quota_usage
  DROP CONSTRAINT youtube_service_quota_usage_date_pacific_api_key_id_pk;

ALTER TABLE youtube_service_quota_usage
  ADD CONSTRAINT youtube_service_quota_usage_date_pacific_api_key_id_pool_kind_pk
  PRIMARY KEY (date_pacific, api_key_id, pool_kind);

-- 3. Drop the DEFAULT now that the column is non-null on every row.
-- Code path (incrementUsage) sets pool_kind explicitly; defaulting masks
-- regressions where a writer forgets to pass it.
ALTER TABLE youtube_service_quota_usage
  ALTER COLUMN pool_kind DROP DEFAULT;

-- pg-boss schema clean-slate for v10 → v12 upgrade.
--
-- pg-boss 11.0 changed job partitioning (queue tables are no longer
-- created per-queue by default; opt-in via `partition: true`). v11 also
-- removed archive tables. v12 migrated to ESM. None of these provide an
-- automigrate path from v10's schema — see release notes for 11.0.0:
-- https://github.com/timgit/pg-boss/releases/tag/11.0.0
--
-- Drop the existing pgboss schema; pg-boss 12 will recreate it on
-- boss.start(). In-flight jobs (poll.active / poll.cold / poll.user) are
-- lost — the scheduler will re-enqueue active/cold work on its next tick
-- (≤ 6 h for active, ≤ 24 h for cold). User-initiated refreshes that were
-- pending will need to be re-clicked. Acceptable trade-off given Phase 03.0
-- only shipped 4 days ago and queue depth is low.
--
-- Idempotent: safe to apply on a clean DB (the IF EXISTS guard skips when
-- the schema is absent — e.g. fresh self-host installs).

DROP SCHEMA IF EXISTS pgboss CASCADE;

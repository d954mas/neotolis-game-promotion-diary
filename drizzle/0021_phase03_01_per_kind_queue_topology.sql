-- Phase 03.0.1 Plan 07 — Per-kind queue topology rename. Forward-only.
-- Cleans up pg-boss internal state for queues retired in this phase.
-- See 03.0.1-RESEARCH.md Pitfalls 1 (queue rename + singletonKey scope) and
-- 5 (pg-boss schedule rows orphan on rename).
--
-- Retired queue names (pre-Plan-07):
--   poll.active                — collapsed into youtube.poll.cron (key=active)
--   poll.cold                  — collapsed into youtube.poll.cron (key=cold)
--   poll.user                  — renamed to youtube.poll.user
--   scheduler.tick.active      — retired (cron schedule now drives youtube.poll.cron directly)
--   scheduler.tick.cold        — retired (cron schedule now drives youtube.poll.cron directly)
--   youtube.rehab_unavailable  — renamed to youtube.rehab (D-11 brevity)
--
-- pgboss.* tables are pg-boss internal state, NOT Drizzle-tracked schema. The
-- DELETEs are safe to apply on a populated pg-boss database — pg-boss
-- regenerates queue + schedule rows on next boot via boss.createQueue +
-- boss.schedule (idempotent v10+). In-flight job rows for retired queues
-- are also dropped (acceptable per CONTEXT.md "Specifics — migrations not
-- a problem"; production v0.1 has no live YouTube poll data, and a
-- hypothetical re-deploy with active jobs would have the scheduler
-- re-enqueue within ~6 hours via the new youtube.poll.cron schedule).
--
-- Idempotency: the DELETEs are wrapped in a DO $$ ... END $$ guard that
-- checks for the pgboss schema's existence. This matches the precedent
-- established in 0010_phase03_baseline.sql (which cleaned poll.hot /
-- poll.warm rows the same way) and keeps the migration safe on fresh test
-- DBs (where pgboss has not yet booted) and on deploy hosts where the
-- migration has already run once.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') THEN
    -- 1) Drop schedule rows for retired schedules. pg-boss persists boss.schedule
    --    calls in pgboss.schedule keyed by (queue_name, key).
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'schedule') THEN
      DELETE FROM pgboss.schedule WHERE name IN (
        'poll.active',
        'poll.cold',
        'poll.user',
        'scheduler.tick.active',
        'scheduler.tick.cold',
        'youtube.rehab_unavailable'
      );
    END IF;

    -- 2) Drop queue declarations. pg-boss createQueue is idempotent on the
    --    next boot; orphan rows for retired names just sit unused otherwise.
    --    Cleaner to remove them so /admin/quota and operator-facing queue
    --    inventory don't show the dead names.
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'queue') THEN
      DELETE FROM pgboss.queue WHERE name IN (
        'poll.active',
        'poll.cold',
        'poll.user',
        'scheduler.tick.active',
        'scheduler.tick.cold',
        'youtube.rehab_unavailable'
      );
    END IF;

    -- 3) Drop in-flight job rows for retired queues. In dev (no prod youtube
    --    poll data — see CONTEXT.md Specifics, "migrations not a problem"),
    --    losing in-flight jobs is acceptable. In a hypothetical prod
    --    re-deploy, scheduler re-enqueues on the next cron tick within 6
    --    hours.
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job') THEN
      DELETE FROM pgboss.job WHERE name IN (
        'poll.active',
        'poll.cold',
        'poll.user',
        'scheduler.tick.active',
        'scheduler.tick.cold',
        'youtube.rehab_unavailable'
      );
    END IF;
  END IF;
END $$;

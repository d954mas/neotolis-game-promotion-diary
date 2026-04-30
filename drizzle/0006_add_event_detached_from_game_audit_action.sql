-- 0006_add_event_detached_from_game_audit_action
-- Plan 02.1-27 (round-4 gap closure): completes UAT-NOTES.md §4.24.G's
-- audit-verb mirror. Single ALTER TYPE … ADD VALUE statement isolated in
-- its own migration file per Pitfall 1 (Postgres 16 ALTER TYPE rules) +
-- Plan 02.1-12 precedent (which shipped 0001_add_post_kind.sql with the
-- same pattern). One statement per file = one tx per file = no risk of
-- "ALTER TYPE … ADD cannot run inside a transaction block" errors.

ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'event.detached_from_game';--> statement-breakpoint

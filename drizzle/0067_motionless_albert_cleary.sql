-- Author @handle snapshot for source-less manual social pastes (fallback-only
-- display label; see events.ts header for the no-denorm justification).
-- Rollback (emergency only — forward-only by AGENTS.md):
--   ALTER TABLE "events" DROP COLUMN "author_handle";
ALTER TABLE "events" ADD COLUMN "author_handle" text;
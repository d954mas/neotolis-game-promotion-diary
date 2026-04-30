-- 0007_add_games_description
-- Plan 02.1-39 round-6 polish #14a (UAT-NOTES.md §5.8 follow-up #14,
-- 2026-04-30). User during round-6 UAT after polish #13 landed
-- (verbatim, ru):
--   "Еще я хочу чтобы тут можно было сделать описание игры."
--   ("I also want to be able to add a description for the game here.")
--
-- Forward-only migration adds a nullable text column. Service-layer
-- validates max 2000 chars; DB has no length constraint to keep the
-- migration a pure additive change (zero rows touched, zero downtime
-- for self-host operators on a running container — drizzle-kit migrate
-- runs at boot under advisory lock per AGENTS.md "Migrations forward-
-- only, run at boot").
--
-- The `games_user_id_idx` and `games_user_id_created_at_idx` indexes
-- are unaffected by this column. Tenant-scope invariant from AGENTS.md
-- "Privacy & multi-tenancy" continues to hold via the existing
-- `eq(games.userId, userId)` filter on every read/write path.

ALTER TABLE "games" ADD COLUMN IF NOT EXISTS "description" text;

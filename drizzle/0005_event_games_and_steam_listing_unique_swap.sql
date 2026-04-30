-- 0005_event_games_and_steam_listing_unique_swap
-- Plan 02.1-27 (round-4 gap closure): UAT-NOTES.md §4.24.G + §4.25.J.
-- Pure-DDL forward-only migration: CREATE TABLE event_games (M:N junction)
-- + DROP CONSTRAINT (game_steam_listings_user_app_id_unq) + DROP COLUMN
-- (events.game_id). All table-shape changes are safe inside a single
-- transaction. The companion ALTER TYPE migration (audit_action enum
-- extension) ships as 0006_*.sql per Pitfall 1 + Plan 02.1-12 precedent.
-- Pre-launch (CONTEXT D-04) + forward-only discipline (DV-2) — 0005 is
-- the next idx after 0004.

CREATE TABLE IF NOT EXISTS "event_games" (
  "event_id" text NOT NULL REFERENCES "events" ("id") ON DELETE CASCADE,
  "game_id" text NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("event_id", "game_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_games_user_id_idx" ON "event_games" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_games_game_id_idx" ON "event_games" ("game_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_games_user_game_idx" ON "event_games" ("user_id", "game_id");--> statement-breakpoint

DROP INDEX IF EXISTS "events_user_id_game_id_occurred_at_idx";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "game_id";--> statement-breakpoint

ALTER TABLE "game_steam_listings" DROP CONSTRAINT IF EXISTS "game_steam_listings_user_app_id_unq";

-- Phase 11 (twitter-x-adapter) — global QPS pacer for the twitterapi.io key.
-- twitterapi.io rate-limits PER API KEY (0.2 QPS never-paid / 3 QPS after a
-- top-up), shared across backfill + warm-refresh + paste and across replicas.
-- Single-row token table; every twitterFetch atomically bumps next_allowed_at
-- BEFORE its call so the global rate never crosses the floor. Mirrors
-- reddit_pacer / telegram_pacer MINUS the escalating pause columns (twitter's
-- 429 self-resumes via retryAfterMs — the pacer is only the proactive gate).
-- Forward-only (AGENTS.md). Emergency rollback: DROP TABLE twitter_pacer;
CREATE TABLE "twitter_pacer" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"next_allowed_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "twitter_pacer_id_check" CHECK ("twitter_pacer"."id" = 1)
);
--> statement-breakpoint
-- Seed the singleton pacer row (id=1). drizzle-kit generate does not emit data,
-- so this is added by hand — matching the reddit_pacer / telegram_pacer
-- migrations. The application code never INSERTs / DELETEs this row; it only
-- atomically reads + bumps next_allowed_at. ON CONFLICT DO NOTHING is idempotent.
INSERT INTO "twitter_pacer" ("id", "next_allowed_at")
VALUES (1, NOW())
ON CONFLICT ("id") DO NOTHING;

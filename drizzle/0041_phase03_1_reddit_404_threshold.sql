-- Phase 03.1 — flagNotFoundOnSubscribers threshold backing columns.
--
-- Pre-fix: a single 404 from /r/X/new.json or /user/X/submitted.json
-- immediately flagged every subscriber of that sub/user with
-- needs-reconnect. A transient outage (banned-then-unbanned subreddit,
-- brief Reddit unavailability) hurts users who did nothing wrong.
--
-- Post-fix: track consecutive 404s on the cross-tenant cache row.
-- sub-poll / author-poll flag subscribers only after N consecutive 404s
-- within a recent window (threshold + window constants live in
-- src/lib/sources/reddit/server/not-found-tracker.ts; default 3-in-24h).
-- A successful poll resets the counter to 0.

ALTER TABLE "reddit_users_cache" ADD COLUMN "not_found_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reddit_users_cache" ADD COLUMN "last_not_found_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reddit_subreddits_cache" ADD COLUMN "not_found_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reddit_subreddits_cache" ADD COLUMN "last_not_found_at" timestamp with time zone;

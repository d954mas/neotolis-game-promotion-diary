-- Phase 02.2 review (post-fix #4): composite index on (user_id, created_at DESC)
-- to keep the events_per_day quota count fast as users accumulate events.
--
-- The existing events_user_occurred_at_idx is keyed off occurred_at (the
-- user-meaningful "when the event happened" timestamp), but the quota guard
-- queries `createdAt >= now() - 24h` — wall-clock INSERT time. Without this
-- index, Postgres seeks by user_id then row-fetch-filters createdAt; an
-- active user with 10k+ events pays the tail-row scan on every quota check.
-- Forward-only, no down migration; runs under advisory lock on container boot.

CREATE INDEX "events_user_created_at_idx" ON "events" USING btree ("user_id","created_at" DESC);

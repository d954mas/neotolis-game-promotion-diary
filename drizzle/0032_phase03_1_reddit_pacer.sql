-- Phase 03.1 follow-up: global Reddit rate-limit pacer.
--
-- The 8-tick worker (worker-tick.ts setInterval 7.5s) was the SOLE Reddit
-- HTTP path under the original plan. Two later changes broke that
-- invariant:
--   1. fetchEventPreviewMetadata (Reddit /events/new "Get info" button)
--      calls handlePostSingle synchronously — live Reddit fetch outside
--      the worker.
--   2. fetchEventStats on createEvent (Reddit paste Submit) calls
--      handlePostSingle synchronously — also live Reddit fetch outside
--      the worker.
--
-- usesInProcessRateLimiter=true blocks WORKER_REPLICA_COUNT>1, but it
-- does NOT block N concurrent BROWSER sessions from each firing a
-- preview/submit at the same moment. Without a DB-side pacer, 5 users
-- pasting at the same second produce 5 simultaneous Reddit fetches +
-- worker tick — 6 req in 1s, blowing past the 10 req/min Reddit ceiling.
--
-- Solution: single-row pacer table. Every redditFetch atomically updates
-- the row's `next_allowed_at` BEFORE the network call:
--   - If next_allowed_at <= NOW(): bump to NOW() + 7500ms, allow fetch.
--   - Else: throw AdapterError(rate-limited) with retryAfterMs set to
--     (next_allowed_at - NOW()).
--
-- 7500ms tick interval matches the worker's setInterval, so the pacer
-- and the worker share the same effective ceiling (8 req/min). All paths
-- — worker, preview, fetchEventStats, future ad-hoc fetches — funnel
-- through one limiter.

CREATE TABLE IF NOT EXISTS "reddit_pacer" (
  "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "next_allowed_at" timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO "reddit_pacer" ("id", "next_allowed_at")
VALUES (1, NOW())
ON CONFLICT ("id") DO NOTHING;

-- Phase 12 review fix — complete the D-05 raze (0070 dropped the old free-`.json`
-- CACHE tables; this finishes the job on the rows those tables fed).
--
-- DESTRUCTIVE RESET, EXPLICITLY APPROVED BY THE PROJECT OWNER (2026-07-26, review
-- round 2): "old Reddit events / sources / cache can be deleted completely." Reddit
-- auto-import has been dead in prod since the anonymous-`.json` 403 (see the
-- reddit-proxy-403 finding), there are no external users, and users re-add their
-- Reddit sources after deploy. ROLLBACK: restore from a pre-deploy backup — the
-- deleted rows are not recoverable forward-only (AGENTS.md: no down-migrations).
--
-- WHY the events go too (the earlier detach-only version was not enough): the razed
-- adapter keyed events on the BARE base36 post id while the rebuilt walker keys on the
-- `t3_<id>` fullname, and it stored walk keys as metadata {username}/{subreddit} while
-- the rebuilt walker reads {handle}/{slug}. A retained event therefore joins NOTHING in
-- the new reddit_posts cache — no stats, no thumbnail, no media type, forever — while
-- still occupying the (user_id, source_id, external_id) uniqueness slot the rebuilt
-- walker needs. A source row would resolve a garbage channelKey (its own UUID), burn a
-- credit on an empty author-search and flag needs_reconnect forever.
--
-- SCOPE: `kind = 'reddit_post'` events and `reddit_account`/`reddit_subreddit` sources
-- ONLY. Every other platform's events, sources and channel-state rows are untouched —
-- asserted by tests/integration/reddit-legacy-raze-migration.test.ts.
--
-- The old CACHE is already gone: 0070 ran `DROP TABLE reddit_posts / reddit_users_cache
-- / reddit_subreddits_cache / reddit_post_snapshots / reddit_user_snapshots /
-- reddit_subreddit_snapshots / reddit_subreddit_baselines / reddit_pacer CASCADE` and
-- purged the `reddit_account` refresh-queue lanes; 0071 created the four fresh
-- ScrapeCreators tables EMPTY. Nothing to delete here.
--
-- HAND-WRITTEN ON PURPOSE: this is a DATA migration (no schema change), which
-- `drizzle-kit generate` cannot express — see the AGENTS.md "Forward-only migrations"
-- clause covering hand-written data migrations (idempotent, test-covered, no DDL).
--
-- IDEMPOTENT BY SHAPE, not by "it only runs once". Each predicate additionally matches
-- the LEGACY row shape, so a re-run — a repair migration (this repo already needed one:
-- 0062), an operator executing the file by hand after a partial deploy, or a restored
-- backup re-migrated — is a genuine no-op instead of wiping everything the rebuilt
-- walker has imported since. Without these the predicates match the NEW rows exactly as
-- well as the old ones.
--
--   events               : legacy rows key on the BARE base36 id; the rebuilt walker
--                          writes the `t3_` fullname. (external_id IS NULL covers a
--                          legacy row that never resolved one.)
--   data_sources         : legacy rows carry metadata {username}/{subreddit}; the
--                          rebuilt canonicalizeOnCreate writes {handle}/{slug}.
--   data_source_channel_state : legacy rows are the ones with no surviving source.
DELETE FROM "events"
 WHERE "kind"::text = 'reddit_post'
   AND ("external_id" IS NULL OR "external_id" NOT LIKE 't3\_%');--> statement-breakpoint
DELETE FROM "data_sources"
 WHERE "kind"::text IN ('reddit_account', 'reddit_subreddit')
   AND NOT ("metadata" ? 'handle' OR "metadata" ? 'slug');--> statement-breakpoint
DELETE FROM "data_source_channel_state" dscs
 WHERE dscs."kind"::text IN ('reddit_account', 'reddit_subreddit')
   AND NOT EXISTS (
     SELECT 1 FROM "data_sources" ds
      WHERE ds."kind" = dscs."kind" AND ds."channel_id" = dscs."channel_key"
   );

-- Phase 12-02 (D-05): raze the OLD free-`.json` Reddit adapter tables ahead of the
-- ScrapeCreators rebuild. This is a DESTRUCTIVE drop — the operator's explicit D-05
-- call (no external users; Reddit auto-import already dead in prod, see
-- project_reddit_proxy_403 memory). Paired with 0071 (CREATE the four fresh tables).
-- ROLLBACK: restore from a pre-0070 backup — the dropped rows are not recoverable
-- forward-only. There is no down-migration (forward-only policy, AGENTS.md).
DROP TABLE "reddit_posts" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_users_cache" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddits_cache" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_post_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_user_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddit_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddit_baselines" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_pacer" CASCADE;--> statement-breakpoint
-- Purge stale service-lane rows for the old reddit_account adapter kind. The
-- refresh queue survives the table drop (it is not FK'd to reddit_posts); its
-- reddit_account lanes reference the now-razed walker/upsert path, so they would
-- fail forever. The rebuilt adapter (Plan 12-05) re-enqueues fresh lanes.
DELETE FROM "adapter_refresh_queue" WHERE "adapter_kind" = 'reddit_account';
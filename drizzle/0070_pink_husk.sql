-- Phase 12-02 (D-05): raze the OLD free-`.json` Reddit adapter tables ahead of the
-- ScrapeCreators rebuild. This is a DESTRUCTIVE drop — the operator's explicit D-05
-- call (no external users; Reddit auto-import already dead in prod, see
-- project_reddit_proxy_403 memory). Paired with 0071 (CREATE the four fresh tables).
-- ROLLBACK: restore from a pre-0070 backup — the dropped rows are not recoverable
-- forward-only. There is no down-migration (forward-only policy, AGENTS.md).
-- Stale adapter_refresh_queue rows are cleaned separately by the pure-DML 0075
-- migration so generated schema DDL never mixes with a hand-written data operation.
DROP TABLE "reddit_posts" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_users_cache" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddits_cache" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_post_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_user_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddit_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_subreddit_baselines" CASCADE;--> statement-breakpoint
DROP TABLE "reddit_pacer" CASCADE;

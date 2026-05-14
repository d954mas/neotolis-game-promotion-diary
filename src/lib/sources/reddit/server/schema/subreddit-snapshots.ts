// reddit_subreddit_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Time-series of
// per-subreddit growth metrics (`subscribers`, `accounts_active`)
// captured daily from `/r/X/about.json`.
//
// Per D-RDT-SUB-SNAPSHOTS, snapshots are captured by the `sub_poll`
// worker handler for ALL cached subreddits (not just OWNED — every
// subreddit a user pastes a post into gets tracked over time so the
// per-sub baselines and growth-rate context columns stay accurate).
// Either combined into the same handler tick as the main sub_poll
// (2 HTTP calls back-to-back) OR split into a separate `sub_metadata_
// refresh` queue type — planner picks in plan 03.1-05A/05B.
//
// `(subreddit, polled_at)` UNIQUE makes within-the-minute retries
// idempotent (date_trunc('minute', NOW()) on insert — see D-RDT-
// SNAPSHOTS).
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope (time-series; all cached subs)" comment.

import { pgTable, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";
import { redditSubredditsCache } from "./subreddits.js";

export const redditSubredditSnapshots = pgTable(
  "reddit_subreddit_snapshots",
  {
    subreddit: text("subreddit")
      .notNull()
      .references(() => redditSubredditsCache.name),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    subscribers: integer("subscribers"),
    accountsActive: integer("accounts_active"),
  },
  (t) => ({
    // Composite PK — see post-snapshots.ts for rationale.
    pk: primaryKey({ columns: [t.subreddit, t.polledAt] }),
  }),
);

export type RedditSubredditSnapshot = typeof redditSubredditSnapshots.$inferSelect;
export type NewRedditSubredditSnapshot = typeof redditSubredditSnapshots.$inferInsert;

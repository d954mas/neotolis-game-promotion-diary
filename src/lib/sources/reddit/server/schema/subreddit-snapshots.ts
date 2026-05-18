// reddit_subreddit_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Time-series of
// per-subreddit growth metrics (`subscribers`, `accounts_active`)
// captured daily from `/r/X/about.json`.
//
// Snapshots are captured for ALL cached subreddits (not just OWNED) so
// the per-sub baselines and growth-rate context columns stay accurate
// for every subreddit a user pastes into. They land via a dedicated
// about-refresh queue work item, NOT inline with sub_poll's /new.json
// fetch — the global pacer would deny a second redditFetch in the
// same tick.
//
// `(subreddit, polled_at)` composite PK makes within-the-minute retries
// idempotent (insert via date_trunc('minute', NOW())).
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope (time-series; all cached subs)" comment.

import { pgTable, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";
import { redditSubredditsCache } from "./subreddits.js";

export const redditSubredditSnapshots = pgTable(
  "reddit_subreddit_snapshots",
  {
    // ON UPDATE CASCADE / ON DELETE CASCADE — see migration
    // 0040_phase03_1_lowercase_reddit_identifiers.sql header for the
    // case-insensitive identifier rationale: parent PK rename
    // (lowercase normalisation) must re-point children automatically;
    // parent row drop (collision dedup) drops derived snapshots too.
    subreddit: text("subreddit")
      .notNull()
      .references(() => redditSubredditsCache.name, {
        onUpdate: "cascade",
        onDelete: "cascade",
      }),
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

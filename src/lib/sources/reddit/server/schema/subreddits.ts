// reddit_subreddits_cache — our local copy of subreddit metadata
// (description, subscribers, submission requirements, rules).
//
// PUBLIC-DATA — no `user_id` column by design. One row per subreddit
// name (PK, the lowercase canonical form without the `r/` prefix).
// Subreddit metadata is identical across every tenant who ever pastes
// a post from that subreddit.
//
// Populated lazily on first encounter:
//   - `post_single` / `sub_poll` handlers UPSERT here when a post's
//     subreddit has not been seen before. Initial UPSERT writes the
//     `name` PK + `subreddit_id` (`t5_xxx` fullname); rest of the
//     fields stay NULL until the next opportunistic `/r/X/about.json`
//     fetch.
//   - Daily `sub_poll` cron opportunistically fetches
//     `/r/X/about.json` once per day per subreddit to refresh
//     `subscribers` / `accounts_active` / `description` /
//     `submission_metadata`. Snapshot row written to
//     `reddit_subreddit_snapshots` from same response.
//   - `rules_raw_json` / `rules_fetched_at` populated separately when
//     UI shows the per-subreddit rule panel (planner choice — fetch
//     lazily on first display, OR via the same daily cron tick).
//
// `submission_metadata` jsonb captures Reddit's per-subreddit posting
// quirks: `submission_type` ('any'/'link'/'self'), `allow_videos`,
// `allow_galleries`, `over18`, etc. Free-form so future Reddit API
// fields don't trigger a schema migration.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope" comment.

import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const redditSubredditsCache = pgTable(
  "reddit_subreddits_cache",
  {
    name: text("name").primaryKey(),
    subredditId: text("subreddit_id"),
    subscribers: integer("subscribers"),
    accountsActive: integer("accounts_active"),
    description: text("description"),
    publicDescription: text("public_description"),
    submissionMetadata: jsonb("submission_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    rulesRawJson: jsonb("rules_raw_json"),
    rulesFetchedAt: timestamp("rules_fetched_at", { withTimezone: true }),
    over18: boolean("over18").notNull().default(false),
    subredditType: text("subreddit_type"),
    lastMetadataRefreshAt: timestamp("last_metadata_refresh_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Reddit listing pagination cursor (`data.after` from /new.json).
     *  Non-NULL while a deep walk is in progress; NULL means either the
     *  walk is complete (see backfillComplete) or we haven't started yet.
     *  Saved cross-tenant on the public cache row — one walk per
     *  subreddit, all subscribers free-ride on the same fan-out. */
    backfillAfterCursor: text("backfill_after_cursor"),
    /** True once the walker reached `data.after === null` — Reddit either
     *  ran out of listing entries OR hit its ~1000-item public cap. From
     *  this point on sub_poll switches to incremental (no cursor) and
     *  only picks up new posts at the top of /new. */
    backfillComplete: boolean("backfill_complete").notNull().default(false),
    /** Oldest `created_utc` we've fetched during the deep walk. Surfaces
     *  on the operator dashboard so we can see "how far back into r/X
     *  history have we gone" without scanning reddit_posts. */
    backfillDeepestAt: timestamp("backfill_deepest_at", { withTimezone: true }),
  },
  (t) => ({
    // Daily refresh-cron picks stale rows for /r/X/about.json walk.
    lastRefreshIdx: index("idx_reddit_subreddits_cache_last_refresh").on(t.lastMetadataRefreshAt),
  }),
);

export type RedditSubredditCache = typeof redditSubredditsCache.$inferSelect;
export type NewRedditSubredditCache = typeof redditSubredditsCache.$inferInsert;

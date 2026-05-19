// reddit_users_cache — our local copy of Reddit user / author metadata.
//
// PUBLIC-DATA — no `user_id` column by design. One row per Reddit
// username (PK). Same author across multiple tenants shares one row.
//
// Populated lazily on first encounter:
//   - `post_single` / `sub_poll` / `author_poll` handlers UPSERT here
//     when a post's author has not been seen before.
//   - `author_poll` handler additionally refreshes karma fields and
//     INSERTs `reddit_user_snapshots` (time-series, OWNED accounts only)
//     opportunistically from the same `/user/X/submitted.json` response.
//
// `reddit_id` carries the `t2_xxx` fullname when known (some legacy
// posts only carry the username string; `reddit_id` stays NULL in that
// case). `is_suspended` flips true if Reddit returns suspended-account
// markers on a follow-up about-page fetch.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope" comment.

import { pgTable, text, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";

export const redditUsersCache = pgTable(
  "reddit_users_cache",
  {
    username: text("username").primaryKey(),
    redditId: text("reddit_id"),
    accountAgeDays: integer("account_age_days"),
    linkKarma: integer("link_karma"),
    commentKarma: integer("comment_karma"),
    totalKarma: integer("total_karma"),
    isSuspended: boolean("is_suspended").notNull().default(false),
    lastMetadataRefreshAt: timestamp("last_metadata_refresh_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Reddit listing pagination cursor for /user/X/submitted.json
     *  (`data.after`). Same semantics as redditSubredditsCache: non-NULL
     *  while a deep walk is in progress, NULL when complete or never
     *  started. */
    backfillAfterCursor: text("backfill_after_cursor"),
    /** Walk done — Reddit hit end-of-listing (typically ~1000 posts for
     *  /user/X/submitted; less if the author has fewer submissions).
     *  Incremental author_poll runs after this point. */
    backfillComplete: boolean("backfill_complete").notNull().default(false),
    /** Oldest `created_utc` fetched during the deep walk. */
    backfillDeepestAt: timestamp("backfill_deepest_at", { withTimezone: true }),
    /** Consecutive 404 count from /user/X/submitted.json. Mirrors the
     *  `reddit_subreddits_cache.not_found_count` semantics — see header
     *  on that table for the gate logic. */
    notFoundCount: integer("not_found_count").notNull().default(0),
    /** Wall-clock of the most recent 404. */
    lastNotFoundAt: timestamp("last_not_found_at", { withTimezone: true }),
  },
  (t) => ({
    // Refresh-cron scan: pick stale rows for re-fetch. Cheap btree on a
    // single nullable column; no partial WHERE needed at indie scale.
    lastRefreshIdx: index("idx_reddit_users_cache_last_refresh").on(t.lastMetadataRefreshAt),
  }),
);

export type RedditUserCache = typeof redditUsersCache.$inferSelect;
export type NewRedditUserCache = typeof redditUsersCache.$inferInsert;

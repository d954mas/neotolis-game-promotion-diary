// reddit_post_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Time-series of
// per-post Reddit stats (score / num_comments / awards_total /
// upvote_ratio / removed_by_category) shared across every tenant who
// has an event for that post. Same upvote count regardless of who
// polled it.
//
// Worker write pattern: one row per successful poll, with
// `(post_id, polled_at)` UNIQUE making within-the-minute retries
// idempotent. `polled_at` is `date_trunc('minute', NOW())` at insert
// time so two retries inside the same minute collapse to one row
// (within-minute idempotency contract; mirrors the YouTube
// per-video snapshots pattern).
//
// `status` column carries the post's live-vs-deleted lifecycle:
//   - 'ok'        — normal post with live score / comments
//   - 'removed'   — moderator / Reddit removed; populate
//                   `removed_by_category` from the API field
//   - 'archived'  — Reddit auto-archived (read-only after 6 months)
//   - 'not_found' — 404 / private subreddit; post no longer reachable
//
// `removed_by_category` mirrors Reddit's API field
// ('deleted' | 'moderator' | 'reddit' | NULL). On the first snapshot
// where this is non-NULL, the worker handler also sets
// `reddit_posts.deletion_detected_at = NOW()` (idempotent — first
// detect only) which starts the 48-hour deletion-propagation clock per
// the 48h deletion-propagation clock.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope" comment.

import { pgTable, text, timestamp, integer, real, primaryKey } from "drizzle-orm/pg-core";
import { redditPosts } from "./posts.js";

export const redditPostSnapshots = pgTable(
  "reddit_post_snapshots",
  {
    postId: text("post_id")
      .notNull()
      .references(() => redditPosts.postId),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    score: integer("score"),
    numComments: integer("num_comments"),
    awardsTotal: integer("awards_total"),
    upvoteRatio: real("upvote_ratio"),
    removedByCategory: text("removed_by_category"),
  },
  (t) => ({
    // (post_id, polled_at) — composite PRIMARY KEY. Stronger semantic
    // than the prior uniqueIndex: this row's identity IS the pair.
    // Pre-fix: 0030 created the table without a PK and added a
    // uniqueIndex with the same columns; same uniqueness guarantee but
    // some ORM/replication tooling treats PK-less tables as second-class
    // (no logical-replication identity, no implicit `tableoid, ctid` PK).
    // Postgres auto-creates the supporting unique index — same read-path
    // shape the chart loader walks for "last N points for post X".
    pk: primaryKey({ columns: [t.postId, t.polledAt] }),
  }),
);

export type RedditPostSnapshot = typeof redditPostSnapshots.$inferSelect;
export type NewRedditPostSnapshot = typeof redditPostSnapshots.$inferInsert;

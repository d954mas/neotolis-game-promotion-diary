// reddit_posts — our local copy of Reddit post metadata + polling
// state.
//
// PUBLIC-DATA — no `user_id` column by design. One row per post keyed
// on `post_id` (PK, "t3_xxx" fullname form). Shared across every tenant
// who ever pastes or polls this post; multiple events for the same
// post share one row via `events.external_id = post_id`.
//
// Populated lazily on first encounter:
//   - User pastes a post URL → ingest enqueues `user_post.post_single`
//     work; worker handler fetches `/comments/<id>.json` → UPSERT here +
//     UPSERT `reddit_users_cache` for author + UPSERT
//     `reddit_subreddits_cache` for subreddit + INSERT
//     `reddit_post_snapshots`.
//   - Source listing-walk (`sub_poll` / `author_poll`) returns posts →
//     same UPSERT + INSERT chain, post-by-post.
//
// Deletion-propagation contract (D-RDT-DELETION-PROPAGATION,
// Reddit Public Content Policy):
//   When the latest snapshot has `removed_by_category != NULL`, the
//   worker sets `deletion_detected_at = NOW()` (idempotent — only on
//   first detect) AND `last_snapshot_at = NOW()` (stop polling). The
//   daily `reddit.cron.deletion-propagation` cron @05:00 UTC purges
//   `author` + `author_fullname` to NULL on rows where
//   `deletion_detected_at IS NOT NULL AND deletion_detected_at <
//   NOW() - INTERVAL '48 hours'`. Title + body excerpt stay (user's
//   diary context); author-identifying info is removed.
//
// Retention contract: rows are NEVER garbage-collected. Identity-only
// for deleted-post entries (author NULL but post_id + permalink + title
// preserved) keeps the diary record stable. Future per-author or
// per-subreddit analytics need the full historical row set.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope" comment.

import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const redditPosts = pgTable(
  "reddit_posts",
  {
    postId: text("post_id").primaryKey(),
    subreddit: text("subreddit").notNull(),
    author: text("author"),
    authorFullname: text("author_fullname"),
    permalink: text("permalink").notNull(),
    title: text("title").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSnapshotAt: timestamp("last_snapshot_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    deletionDetectedAt: timestamp("deletion_detected_at", { withTimezone: true }),
  },
  (t) => ({
    // Sub-poll listing-walks scan (subreddit, submitted_at DESC) — the
    // primary read pattern for `sub_poll` handler frontier checks.
    subredditSubmittedIdx: index("idx_reddit_posts_subreddit_submitted").on(
      t.subreddit,
      t.submittedAt,
    ),
    // Author-poll listing-walks scan (author, submitted_at DESC) for
    // OWNED `reddit_account` sources. Partial WHERE skips
    // deletion-propagated rows (NULL author).
    authorSubmittedIdx: index("idx_reddit_posts_author_submitted")
      .on(t.author, t.submittedAt)
      .where(sql`${t.author} IS NOT NULL`),
    // Snapshot-due scan — worker picks rows where last_snapshot_at is
    // stale AND deletion is not detected. Partial WHERE narrows to the
    // live post set so the cron's SELECT stays cheap as the cache grows.
    lastSnapshotIdx: index("idx_reddit_posts_last_snapshot")
      .on(t.lastSnapshotAt)
      .where(sql`${t.deletionDetectedAt} IS NULL`),
  }),
);

export type RedditPost = typeof redditPosts.$inferSelect;
export type NewRedditPost = typeof redditPosts.$inferInsert;

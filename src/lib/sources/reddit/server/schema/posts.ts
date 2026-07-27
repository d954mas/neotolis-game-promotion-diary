// reddit_posts — our local copy of Reddit post metadata + polling state.
//
// One row per post, keyed on `post_id` (PK = the intrinsic `t3_<base36>`
// fullname, = events.external_id; the spike froze externalId = `post.name`, the
// rename-proof id). PUBLIC-DATA — no `user_id` column by design; identical across
// every tenant who references this post (mirrors twitter_posts / tiktok_posts).
// The ESLint TENANT_TABLES allowlist extends `redditPosts` with an explicit
// "public external data, no tenant scope" comment.
//
// Polling state lives here (not on `events`): `last_polled_at` / `last_poll_
// status` / `poll_failure_count` are properties of the POST, shared by every
// event referencing this external_id via JOIN. Tier classification keys on
// `published_at` (a paste for an old post correctly resolves to Cold/Frozen).
//
// NO denormalized subreddit/account DISPLAY name here (AGENTS.md no-denorm rule):
// `subreddit_slug` is the intrinsic rename-proof slug (the safe denormalization,
// the join key to reddit_subreddits) — NOT the renameable subreddit title, which
// is read from reddit_subreddits at read time.
//
// DELETION-PROPAGATION (D-06/D-08, spike Variant A — free detection only):
// `removed_by_category` is ABSENT from the ScrapeCreators response (spike
// finding), so deletion rides on DISAPPEARANCE-from-walk, not a field flag. When
// a tracked post drops out of the author/subreddit walk (or a one-shot refresh
// returns removed/not-found), the writer sets `deletion_detected_at` (idempotent,
// first-detect only). The daily zero-HTTP purge cron (Plan 12-05) then NULLs
// `author` + `author_fullname` after the grace window (audit written in-tx),
// keeping the diary record (title/body) while removing author-identifying info.
//
// Retention forever — rows are NEVER garbage-collected, even when the last
// referencing event/data_source is gone. The row IS the historical record.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const redditPosts = pgTable(
  "reddit_posts",
  {
    // Intrinsic `t3_<base36>` fullname (= events.external_id). Rename-proof PK.
    postId: text("post_id").primaryKey(),
    // Lowercase subreddit slug (= reddit_subreddits.slug join key + the safe
    // denorm). Nullable until resolved (redd.it short-links omit it).
    subredditSlug: text("subreddit_slug"),
    // Post form: "self" | "link" | "image" | "gallery" (derived from post_hint /
    // domain / url-vs-permalink / selftext / is_video — is_self/thumbnail are
    // ABSENT per spike deviation #2). events.kind stays 'reddit_post' for all
    // forms; the per-post form lives here.
    mediaType: text("media_type"),
    // The post title.
    title: text("title"),
    // The self-post body excerpt (null for link/image posts).
    caption: text("caption"),
    // https://www.reddit.com/r/<sub>/comments/<id>/<slug>
    permalink: text("permalink"),
    thumbnailUrl: text("thumbnail_url"),
    // Drives tier classification. NULL on rows freshly inserted before backfill
    // resolves created_utc.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
    // ★ Deletion-propagation carry-over columns (D-06). author = the Reddit
    // username (PURGED to NULL by the deletion-propagation cron); author_fullname
    // = the `t2_` stable id (also purged). deletion_detected_at gates the purge.
    author: text("author"),
    authorFullname: text("author_fullname"),
    deletionDetectedAt: timestamp("deletion_detected_at", { withTimezone: true }),
    // The KIND-QUALIFIED SUBJECT (`${kind}:${channelKey}` — e.g.
    // "reddit_account:foo" / "reddit_subreddit:foo") whose Variant-A walk detected the
    // disappearance that set deletion_detected_at. A post is shared across authors +
    // subreddits, so "deleted" is subject-relative: only the SAME subject's re-sighting
    // (clear-on-reappear) may un-flag it — otherwise a subreddit walk that still sees an
    // author-deleted post alive in the sub feed would clobber the author's 48h GDPR
    // purge clock. The kind prefix is load-bearing: an author username and a subreddit
    // slug can be the same string (u/foo vs r/foo), so a bare channelKey would let one
    // clear the other's clock. NULL for the dormant write-path removed_by_category belt
    // (an explicit removal is sticky — no clear).
    deletionDetectedBy: text("deletion_detected_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Author-walk frontier — the newest-post-per-author lookup for OWNED
    // reddit_account sources. Partial WHERE skips deletion-propagated rows
    // (NULL author).
    authorPublishedIdx: index("idx_reddit_posts_author")
      .on(t.author, t.publishedAt)
      .where(sql`${t.author} IS NOT NULL`),
    // FUNCTIONAL twin of the above. Every author predicate in the codebase folds case
    // (`LOWER(author) = channelKey`) because the column stores the verbatim display
    // spelling while channelKey is lowercased — and a plain btree on `author` cannot
    // serve a `LOWER(author)` predicate. Without this index the poll-cron tier
    // subquery (correlated: once per candidate row, twice in the active branch) and
    // both deletion reconcilers sequentially scan a table the schema retains FOREVER.
    authorLowerPublishedIdx: index("idx_reddit_posts_author_lower")
      .on(sql`LOWER(${t.author})`, t.publishedAt)
      .where(sql`${t.author} IS NOT NULL`),
    // Subreddit-walk frontier — the newest-post-per-sub lookup for
    // reddit_subreddit sources.
    subredditPublishedIdx: index("idx_reddit_posts_subreddit_published").on(
      t.subredditSlug,
      t.publishedAt,
    ),
    // Tier classification — published_at is the load-bearing signal. Partial
    // index stays narrow over the rare null-published (pre-backfill) rows.
    publishedAtIdx: index("idx_reddit_posts_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
    // resolveCachedExternalId — canonical-permalink lookup on every event create
    // (untrusted-body trust boundary, #70).
    permalinkIdx: index("idx_reddit_posts_permalink").on(t.permalink),
    // Poll-due picker — the "active" (not-yet-deleted) post set the daily walk /
    // one-shot catch scan by staleness. Partial WHERE narrows to live posts so
    // the cron SELECT stays cheap as the cache grows.
    activePollIdx: index("idx_reddit_posts_active_poll")
      .on(t.lastPolledAt)
      .where(sql`${t.deletionDetectedAt} IS NULL`),
  }),
);

export type RedditPost = typeof redditPosts.$inferSelect;
export type NewRedditPost = typeof redditPosts.$inferInsert;

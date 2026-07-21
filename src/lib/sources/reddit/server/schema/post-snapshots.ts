// reddit_post_snapshots — per-poll time-series of a Reddit post's public metrics.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. The score / comment counts
// aggregated against `post_id` are identical for every tenant with an event for
// that post. The ESLint TENANT_TABLES allowlist extends `redditPostSnapshots`
// with an explicit "public external data, no tenant scope (time-series)" comment.
//
// Mirrors twitter_post_snapshots / tiktok_post_snapshots. One row per successful
// poll; `(post_id, polled_at)` UNIQUE makes within-the-minute retries idempotent
// (`INSERT ... ON CONFLICT DO NOTHING`). `polled_at` is `date_trunc('minute',
// now())` at insert time so two retries in the same minute collapse to one row.
//
// METRIC MAPPING (Reddit, D-09 — spike-frozen):
//   - like_count    = `score` (the net ups). The cross-source "likes" metric.
//   - comment_count = `num_comments`. The cross-source "comments" metric.
//   - view_count    = null-by-mapping (Reddit does not expose per-post views) —
//     NO view column exists here (not stored as 0; simply absent).
//   - share_count   = null-by-mapping (`num_crossposts` is ABSENT from the
//     ScrapeCreators response per spike Q4) — NO share column.
//
// RAW D-09 COLUMNS: `score` / `upvote_ratio` / `num_comments` / `num_crossposts`
// / `removed_by_category` are retained verbatim so the history stays
// reconstructable without a re-fetch. NOTE (spike): the provider currently
// returns `upvote_ratio`/`num_crossposts` as null and NEVER populates
// `removed_by_category` — the columns exist for forward-compat + the raw-column
// contract, but deletion detection rides on disappearance-from-walk (see
// reddit_posts header), NOT this column.
//
// METRICS-BY-PRESENCE: a metric whose field is absent is stored null, never 0.

import { pgTable, text, bigint, integer, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const redditPostSnapshots = pgTable(
  "reddit_post_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    postId: text("post_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    // Normalized cross-source metrics (nullable — metrics-by-presence).
    // like_count = score, comment_count = num_comments.
    likeCount: bigint("like_count", { mode: "number" }),
    commentCount: bigint("comment_count", { mode: "number" }),
    // Raw D-09 platform-owned columns — retained verbatim (history stays
    // reconstructable). All nullable (metrics-by-presence).
    score: integer("score"),
    upvoteRatio: real("upvote_ratio"),
    numComments: integer("num_comments"),
    numCrossposts: integer("num_crossposts"),
    // Deletion signal slot (currently never populated by the provider — see
    // header; deletion rides on disappearance-from-walk).
    removedByCategory: text("removed_by_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (post_id, polled_at) — UNIQUE index doubles as the idempotency guard for
    // INSERT ON CONFLICT DO NOTHING AND the read index the chart loader scans.
    postPolledUnq: uniqueIndex("reddit_post_snapshots_post_polled_unq").on(t.postId, t.polledAt),
  }),
);

export type RedditPostSnapshot = typeof redditPostSnapshots.$inferSelect;
export type NewRedditPostSnapshot = typeof redditPostSnapshots.$inferInsert;

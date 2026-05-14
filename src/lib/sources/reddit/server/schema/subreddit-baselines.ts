// reddit_subreddit_baselines.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Pre-computed
// per-subreddit median + p75 stats over a rolling window. Each cached
// subreddit gets two rows: `window_label='30d'` (recent context) and
// `window_label='all_time'` (long-term, capped at 365d so 2-year-old
// data doesn't skew toward old Reddit norms).
//
// Computed nightly @04:00 UTC by `reddit.cron.subreddit-baselines` —
// JOINs `reddit_posts` against `reddit_post_snapshots` at the
// ~24h-after-submission mark and aggregates via `PERCENTILE_CONT`:
//   median_score_24h        — median post score at the 24h mark
//   p75_score_24h           — 75th percentile
//   median_comments_24h     — median comment count at the 24h mark
//   p75_comments_24h        — 75th percentile
//   median_upvote_ratio_24h — median upvote ratio at the 24h mark
//
// `sample_size` is the count of posts contributing to the aggregate;
// the cron emits a row only when sample_size >= 5 (insufficient sample
// would publish misleading numbers). UI shows "Insufficient sample —
// baseline pending" when no row exists.
//
// Used by `/feed` per-post enrichment to render "Your post in r/X
// underperforms median (16% of typical score)" context inline with the
// diary entry.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope (per-sub aggregates)" comment.

import { pgTable, text, timestamp, integer, real, primaryKey } from "drizzle-orm/pg-core";

export const redditSubredditBaselines = pgTable(
  "reddit_subreddit_baselines",
  {
    subreddit: text("subreddit").notNull(),
    windowLabel: text("window_label").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    sampleSize: integer("sample_size").notNull(),
    medianScore24h: real("median_score_24h"),
    p75Score24h: real("p75_score_24h"),
    medianComments24h: real("median_comments_24h"),
    p75Comments24h: real("p75_comments_24h"),
    medianUpvoteRatio24h: real("median_upvote_ratio_24h"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subreddit, t.windowLabel] }),
  }),
);

export type RedditSubredditBaseline = typeof redditSubredditBaselines.$inferSelect;
export type NewRedditSubredditBaseline = typeof redditSubredditBaselines.$inferInsert;

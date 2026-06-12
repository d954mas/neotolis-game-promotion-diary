// twitter_post_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Snapshot rows hold the
// Twitter/X view/like/comment/SHARE metrics aggregated against `tweet_id`; the
// same numbers apply to every tenant who has an event for that tweet, so storing
// per-tenant copies would waste disk and burn credits for no privacy benefit. The
// ESLint TENANT_TABLES allowlist
// (eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js) extends
// `twitterPostSnapshots` with an explicit "public external data, no tenant scope
// (time-series)" comment so the no-unfiltered-tenant-query rule does not trip on
// legitimate `db.select().from(twitterPostSnapshots)` calls.
//
// Mirrors youtube_video_snapshots / instagram_post_snapshots / tiktok_post_
// snapshots. Worker write pattern: one row per successful poll, with `(tweet_id,
// polled_at)` UNIQUE making within-the-minute retries idempotent (`INSERT ... ON
// CONFLICT DO NOTHING`). `polled_at` is `date_trunc('minute', now())` at insert
// time so two retries inside the same minute collapse to one row. Counts are
// bigint (viral tweets exceed 2^31 impressions).
//
// METRIC MAPPING (Twitter/X):
//   - view_count    = the tweet's impression count (views)
//   - like_count    = favorites
//   - comment_count = replies
//   - share_count   = the DERIVED retweet_count + quote_count (the normalizer
//     computes this sum in Plan 02). This IS the PLAT-03 metric — the equivalent
//     of TikTok's share count, reconstructed from the two Twitter components.
//
// D-05 — RAW COMPONENT RETENTION: this table stores BOTH the derived `share_count`
// sum AND the raw `retweet_count` / `quote_count` / `bookmark_count` components.
// Storing the raw components means the shares split stays reconstructable later
// (a future "retweets vs quotes" breakdown needs no re-fetch) AND bookmarks — a
// Twitter-specific engagement signal with no slot in the shared view/like/
// comment/share shape — are never lost. The derived `share_count` is what the
// cross-source charts read; the raw columns are the audit trail.
//
// METRICS-BY-PRESENCE: a metric whose field is absent from the upstream response
// is stored null, never 0 (mirrors IG's view_count-null-on-photos rule). E.g. a
// protected/limited tweet may omit the impression count → view_count is null.
//
// Deep-history backfill yields a CURRENT snapshot of old tweets, NOT historical
// trends — per-post time-series accrues only from when tracking starts.

import { pgTable, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const twitterPostSnapshots = pgTable(
  "twitter_post_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tweetId: text("tweet_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    // view_count = the tweet's impression count (views).
    viewCount: bigint("view_count", { mode: "number" }),
    // like_count = favorites.
    likeCount: bigint("like_count", { mode: "number" }),
    // comment_count = replies.
    commentCount: bigint("comment_count", { mode: "number" }),
    // PLAT-03: the cross-source SHARE metric. DERIVED = retweet_count +
    // quote_count (the normalizer computes the sum in Plan 02). This is the
    // column the "views/likes/comments/shares across all channels" charts read.
    shareCount: bigint("share_count", { mode: "number" }),
    // D-05 raw components — retained so the shares split (retweets vs quotes)
    // stays reconstructable AND bookmarks (a Twitter-specific signal with no slot
    // in the shared shape) are never lost. All nullable (metrics-by-presence).
    retweetCount: bigint("retweet_count", { mode: "number" }),
    quoteCount: bigint("quote_count", { mode: "number" }),
    bookmarkCount: bigint("bookmark_count", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (tweet_id, polled_at) — UNIQUE index doubles as both the idempotency guard
    // for INSERT ON CONFLICT DO NOTHING retries AND the read index the chart
    // loader scans for "show last N points for tweet X".
    tweetPolledUnq: uniqueIndex("twitter_post_snapshots_tweet_polled_unq").on(
      t.tweetId,
      t.polledAt,
    ),
  }),
);

export type TwitterPostSnapshot = typeof twitterPostSnapshots.$inferSelect;
export type NewTwitterPostSnapshot = typeof twitterPostSnapshots.$inferInsert;

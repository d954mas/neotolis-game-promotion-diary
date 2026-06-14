// twitter_posts — our local copy of Twitter/X tweet metadata + polling state.
//
// One row per tweet, keyed on `tweet_id` (PK = the intrinsic stable Twitter/X
// tweet id, also events.external_id). PUBLIC-DATA — no `user_id` column by
// design. Identical across every tenant who ever references this tweet (mirrors
// the youtube_videos / instagram_posts / tiktok_posts public-data semantics). The
// ESLint TENANT_TABLES allowlist
// (eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js) extends
// `twitterPosts` with an explicit "public external data, no tenant scope" comment
// so the no-unfiltered-tenant-query rule does not trip on legitimate
// `db.select().from(twitterPosts)` calls.
//
// Polling state lives here (not on `events`):
//   - `last_polled_at` / `last_poll_status` — last successful or failed attempt
//     to fetch this tweet's metrics from the provider. Properties of the TWEET,
//     not of the user-logged event. Multiple events referencing the same
//     external_id share this state via JOIN.
//   - `poll_failure_count` — increments on every non-ok poll, resets on 'ok'.
//
// Tier classification (Active/Cold/Frozen/Pending/Unavailable) keys on
// `published_at`, not on `events.occurred_at` — a "I logged a promo today for a
// year-old tweet" paste correctly resolves to Cold/Frozen.
//
// NO denormalized account display name here (AGENTS.md no-denorm rule). The
// Twitter/X @handle / display name lives on data_sources (the source-of-truth
// row) + twitter_accounts (the upstream-scraped truth); feed-enrichment JOINs at
// read time so a handle rename reflects everywhere. `account_id` (the stable
// Twitter/X numeric user id) is the only safe identifier to carry — it is the
// account key, part of the canonical identity, not a renameable display value.
//
// Retention contract mirrors youtube_videos / instagram_posts / tiktok_posts:
// rows are NEVER garbage-collected, even when the last referencing event /
// data_source has been deleted. The row IS the historical record for that
// account's per-post stats; future account-level analytics require the full
// historical record.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const twitterPosts = pgTable(
  "twitter_posts",
  {
    // Intrinsic stable Twitter/X tweet id (= events.external_id). tweet_id is the
    // canonical post identifier in the URL/key itself — rename-proof PK.
    tweetId: text("tweet_id").primaryKey(),
    // Stable Twitter/X numeric user id (= twitter_accounts.account_id, the join
    // key). Nullable until the account resolves. Intrinsic identifier (the
    // account key), not a renameable display name — safe to carry.
    accountId: text("account_id"),
    // The content form: "video" | "image" | "text" (D-06) — a tweet carrying a
    // native video → "video"; a photo/animated_gif tweet → "image"; a text-only
    // tweet → "text". ("image" and "text" both classify into the cross-source
    // "other" FILTER category via media-type-filter.ts postMediaKindToCategory.)
    // One-kind-per-platform: events.kind stays the platform-level 'twitter_post'
    // for all forms; the per-post form lives here. (NOT the TikTok
    // "short"/"carousel" vocabulary — a tweet is not a short-form vertical clip.)
    mediaType: text("media_type"),
    // The tweet text.
    caption: text("caption"),
    // https://x.com/<handle>/status/<id>
    permalink: text("permalink"),
    thumbnailUrl: text("thumbnail_url"),
    // Drives tier classification. NULL on rows freshly inserted by ingest before
    // the backfill resolves the tweet's created_at.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Scheduler tier filter — published_at is the load-bearing signal for
    // Active/Cold/Frozen classification. Partial index keeps it narrow over the
    // rare null-published rows (tweets pre-backfill, the 'pending' tier).
    publishedAtIdx: index("idx_twitter_posts_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
    // Poll-cron picker — the per-candidate correlated `MAX(published_at) WHERE
    // account_id = …` newest-post subquery. The composite lets Postgres satisfy
    // the MAX from the index tail without a per-account heap scan.
    accountPublishedAtIdx: index("idx_twitter_posts_account_published_at").on(
      t.accountId,
      t.publishedAt,
    ),
    // resolveCachedExternalId — the canonical-permalink lookup on every event
    // create (untrusted-body trust boundary, #70). Filters by permalink.
    permalinkIdx: index("idx_twitter_posts_permalink").on(t.permalink),
  }),
);

export type TwitterPost = typeof twitterPosts.$inferSelect;
export type NewTwitterPost = typeof twitterPosts.$inferInsert;

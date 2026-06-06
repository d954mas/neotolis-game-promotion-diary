// instagram_posts — our local copy of Instagram post/reel metadata + polling
// state.
//
// One row per post, keyed on `post_id` (PK = the IG media id, also
// events.external_id). PUBLIC-DATA — no `user_id` column by design.
// Identical across every tenant who ever references this post (mirrors the
// youtube_videos public-data semantics). ESLint TENANT_TABLES allowlist
// extends `instagramPosts` with an explicit "public external data, no tenant
// scope" comment (added in Plan 01) so the no-unfiltered-tenant-query rule
// does not trip on legitimate `db.select().from(instagramPosts)` calls.
//
// Polling state lives here (not on `events`):
//   - `last_polled_at` / `last_poll_status` — last successful or failed
//     attempt to fetch this post's metrics from the provider. Properties of
//     the POST, not of the user-logged event. Multiple events referencing the
//     same external_id share this state via JOIN.
//   - `poll_failure_count` — increments on every non-ok poll, resets on 'ok'.
//
// Tier classification (Active/Cold/Frozen/Pending/Unavailable) keys on
// `published_at` (BACK-04), not on `events.occurred_at` — a "I logged a promo
// today for a year-old reel" paste correctly resolves to Cold/Frozen.
//
// NO denormalized account display name here (AGENTS.md no-denorm rule). The
// IG handle / display name lives on data_sources (the source-of-truth row);
// feed-enrichment JOINs at read time so a handle rename reflects everywhere.
// `account_id` (the stable IG user id) is the only safe identifier to carry —
// it is the channel key, part of the canonical identity, not a renameable
// display value.
//
// Retention contract mirrors youtube_videos: rows are NEVER garbage-collected,
// even when the last referencing event / data_source has been deleted. The row
// IS the historical record for that account's per-post stats; future
// account-level analytics require the full historical record.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const instagramPosts = pgTable(
  "instagram_posts",
  {
    postId: text("post_id").primaryKey(),
    // Stable IG user id (= data_source_channel_state.channelKey for this kind).
    // Nullable until resolveAccount has run. This is an intrinsic identifier
    // (the account key), not a renameable display name — safe to carry.
    accountId: text("account_id"),
    // The NormalizedPost.kind: "image" | "carousel" | "video" | "short"
    // (D-06: content form lives here, not in events.kind which stays the
    // platform-level 'instagram_post' for both posts AND reels).
    mediaType: text("media_type"),
    caption: text("caption"),
    permalink: text("permalink"),
    // The fresh IG CDN thumbnail URL (D-08 hotlink). Expires; refreshed on
    // every poll by the snapshot writer.
    thumbnailUrl: text("thumbnail_url"),
    // Drives tier classification (BACK-04). NULL on rows freshly inserted by
    // ingest before the account backfill resolves the post's taken_at.
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
    // Active/Cold/Frozen classification. Partial index keeps it narrow over
    // the rare null-published rows (posts pre-backfill, the 'pending' tier).
    publishedAtIdx: index("idx_instagram_posts_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  }),
);

export type InstagramPost = typeof instagramPosts.$inferSelect;
export type NewInstagramPost = typeof instagramPosts.$inferInsert;

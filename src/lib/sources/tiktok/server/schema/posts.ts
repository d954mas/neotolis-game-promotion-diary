// tiktok_posts — our local copy of TikTok video/photo-post metadata + polling
// state.
//
// One row per post, keyed on `aweme_id` (PK = the intrinsic stable TikTok video
// id, also events.external_id). PUBLIC-DATA — no `user_id` column by design.
// Identical across every tenant who ever references this post (mirrors the
// youtube_videos / instagram_posts public-data semantics). ESLint TENANT_TABLES
// allowlist extends `tiktokPosts` with an explicit "public external data, no
// tenant scope" comment so the no-unfiltered-tenant-query rule does not trip on
// legitimate `db.select().from(tiktokPosts)` calls.
//
// Polling state lives here (not on `events`):
//   - `last_polled_at` / `last_poll_status` — last successful or failed attempt
//     to fetch this post's metrics from the provider. Properties of the POST,
//     not of the user-logged event. Multiple events referencing the same
//     external_id share this state via JOIN.
//   - `poll_failure_count` — increments on every non-ok poll, resets on 'ok'.
//
// Tier classification (Active/Cold/Frozen/Pending/Unavailable) keys on
// `published_at`, not on `events.occurred_at` — a "I logged a promo today for a
// year-old video" paste correctly resolves to Cold/Frozen.
//
// NO denormalized account display name here (AGENTS.md no-denorm rule). The
// TikTok @handle / display name lives on data_sources (the source-of-truth row)
// + tiktok_accounts (the upstream-scraped truth); feed-enrichment JOINs at read
// time so a handle rename reflects everywhere. `account_id` (the stable TikTok
// user id) is the only safe identifier to carry — it is the channel key, part of
// the canonical identity, not a renameable display value.
//
// Retention contract mirrors youtube_videos / instagram_posts: rows are NEVER
// garbage-collected, even when the last referencing event / data_source has been
// deleted. The row IS the historical record for that account's per-post stats;
// future account-level analytics require the full historical record.

import { pgTable, text, timestamp, integer, index, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Postgres bytea ↔ Node Buffer. Drizzle has no first-class bytea column type;
// this is the documented customType bridge (driver returns/accepts Buffer).
const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
});

export const tiktokPosts = pgTable(
  "tiktok_posts",
  {
    // Intrinsic stable TikTok video id (= events.external_id). aweme_id is the
    // canonical post identifier in the URL/key itself — rename-proof PK.
    awemeId: text("aweme_id").primaryKey(),
    // Stable TikTok user id (= tiktok_accounts.account_id, the join key).
    // Nullable until the account resolves. Intrinsic identifier (the account
    // key), not a renameable display name — safe to carry.
    accountId: text("account_id"),
    // The content form: "short" | "carousel" (every TikTok video is a
    // short-form clip → "short"; photo-mode → "carousel"). Supersedes the
    // original D-03 {video, carousel} vocabulary (user re-decided 2026-06-12).
    // One-kind-per-platform (D-06): events.kind stays the platform-level
    // 'tiktok_post' for both forms; the per-post form lives here.
    mediaType: text("media_type"),
    caption: text("caption"),
    permalink: text("permalink"),
    // The fresh TikTok CDN thumbnail URL (hotlink). Expires; refreshed on every
    // poll by the snapshot writer.
    thumbnailUrl: text("thumbnail_url"),
    // Cached cover image bytes, fetched at poll time while thumbnail_url is still
    // a fresh signed URL. The proxy serves these directly so a load never depends
    // on the (hours-short) signature — the daily poll signature expiry caused the
    // steady prod 502 rate on /api/tiktok/thumbnail. NULL on legacy rows not yet
    // re-polled and when the write-time fetch failed (proxy URL-fallback applies).
    // Read ONLY by the proxy — never loaded on the feed/DTO read path.
    thumbnailBytes: bytea("thumbnail_bytes"),
    thumbnailContentType: text("thumbnail_content_type"),
    // Drives tier classification. NULL on rows freshly inserted by ingest before
    // the account backfill resolves the post's create_time.
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
    // rare null-published rows (posts pre-backfill, the 'pending' tier).
    publishedAtIdx: index("idx_tiktok_posts_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
    // Poll-cron picker — the per-candidate correlated `MAX(published_at) WHERE
    // account_id = …` newest-post subquery (one per candidate, up to 200/tick).
    // The composite lets Postgres satisfy the MAX from the index tail without a
    // per-account heap scan.
    accountPublishedAtIdx: index("idx_tiktok_posts_account_published_at").on(
      t.accountId,
      t.publishedAt,
    ),
    // resolveCachedExternalId — the canonical-permalink lookup on every event
    // create (untrusted-body trust boundary, #70). Filters by permalink.
    permalinkIdx: index("idx_tiktok_posts_permalink").on(t.permalink),
  }),
);

export type TiktokPost = typeof tiktokPosts.$inferSelect;
export type NewTiktokPost = typeof tiktokPosts.$inferInsert;

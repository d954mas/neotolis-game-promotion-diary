// tiktok_post_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Snapshot rows hold the
// TikTok view/like/comment/SHARE metrics aggregated against `aweme_id`; the same
// numbers apply to every tenant who has an event for that post, so storing
// per-tenant copies would waste disk and burn credits for no privacy benefit.
// ESLint TENANT_TABLES allowlist extends `tiktokPostSnapshots` with an explicit
// "public external data, no tenant scope (time-series)" comment so the
// no-unfiltered-tenant-query rule does not trip on legitimate
// `db.select().from(tiktokPostSnapshots)` calls.
//
// Mirrors youtube_video_snapshots / instagram_post_snapshots. Worker write
// pattern: one row per successful poll, with `(aweme_id, polled_at)` UNIQUE
// making within-the-minute retries idempotent (`INSERT ... ON CONFLICT DO
// NOTHING`). `polled_at` is `date_trunc('minute', now())` at insert time so two
// retries inside the same minute collapse to one row. Counts are bigint (popular
// TikToks exceed 2^31).
//
// CRITICAL DELTA vs Instagram: `share_count` IS present here (PLAT-02). Instagram
// returns no share field in either endpoint, so instagram_post_snapshots
// deliberately OMITS it (D-04, 08-SPIKE.md); TikTok's API DOES expose a share
// count, which is exactly the metric PLAT-02 requires this adapter to capture, so
// it earns a dedicated column. `share_count` is the TikTok-specific addition to
// the otherwise-shared snapshot shape.
//
// `view_count` may be null on photo-mode (carousel) posts — metrics-by-presence:
// a metric absent on this content type is null, never 0 (mirrors IG's
// view_count-null-on-photos rule).
//
// Deep-history backfill yields a CURRENT snapshot of old posts, NOT historical
// trends — per-post time-series accrues only from when tracking starts.

import { pgTable, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const tiktokPostSnapshots = pgTable(
  "tiktok_post_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    awemeId: text("aweme_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    viewCount: bigint("view_count", { mode: "number" }),
    likeCount: bigint("like_count", { mode: "number" }),
    commentCount: bigint("comment_count", { mode: "number" }),
    // PLAT-02: the IG-omitted metric. TikTok exposes a share count; this is the
    // column that makes the "views/likes/comments/shares across all channels"
    // milestone goal complete for TikTok.
    shareCount: bigint("share_count", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (aweme_id, polled_at) — UNIQUE index doubles as both the idempotency guard
    // for INSERT ON CONFLICT DO NOTHING retries AND the read index the chart
    // loader scans for "show last N points for post X".
    awemePolledUnq: uniqueIndex("tiktok_post_snapshots_aweme_polled_unq").on(t.awemeId, t.polledAt),
  }),
);

export type TiktokPostSnapshot = typeof tiktokPostSnapshots.$inferSelect;
export type NewTiktokPostSnapshot = typeof tiktokPostSnapshots.$inferInsert;

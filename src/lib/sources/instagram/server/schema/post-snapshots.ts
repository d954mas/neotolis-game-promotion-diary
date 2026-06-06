// instagram_post_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Snapshot rows hold the
// Instagram view/like/comment metrics aggregated against `post_id`; the same
// numbers apply to every tenant who has an event for that post, so storing
// per-tenant copies would waste disk and burn credits for no privacy benefit.
// ESLint TENANT_TABLES allowlist extends `instagramPostSnapshots` with an
// explicit "public external data, no tenant scope (time-series)" comment
// (added in Plan 01) so the no-unfiltered-tenant-query rule does not trip on
// legitimate `db.select().from(instagramPostSnapshots)` calls.
//
// Mirrors youtube_video_snapshots. Worker write pattern: one row per
// successful poll, with `(post_id, polled_at)` UNIQUE making within-the-minute
// retries idempotent (`INSERT ... ON CONFLICT DO NOTHING`). `polled_at` is
// `date_trunc('minute', now())` at insert time so two retries inside the same
// minute collapse to one row. Counts are bigint (popular reels exceed 2^31).
//
// `shares` is intentionally omitted — Instagram returns no share field in
// either endpoint (D-04, 08-SPIKE.md). `view_count` is null for photos /
// carousels (D-05 metrics-by-presence — populated only when play_count is
// present, i.e. on reels/video).
//
// Deep-history backfill yields a CURRENT snapshot of old posts, NOT historical
// trends — per-post time-series accrues only from when tracking starts.

import { pgTable, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const instagramPostSnapshots = pgTable(
  "instagram_post_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    postId: text("post_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    viewCount: bigint("view_count", { mode: "number" }),
    likeCount: bigint("like_count", { mode: "number" }),
    commentCount: bigint("comment_count", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (post_id, polled_at) — UNIQUE index doubles as both the idempotency
    // guard for INSERT ON CONFLICT DO NOTHING retries AND the read index the
    // chart loader scans for "show last N points for post X".
    postPolledUnq: uniqueIndex("instagram_post_snapshots_post_polled_unq").on(t.postId, t.polledAt),
  }),
);

export type InstagramPostSnapshot = typeof instagramPostSnapshots.$inferSelect;
export type NewInstagramPostSnapshot = typeof instagramPostSnapshots.$inferInsert;

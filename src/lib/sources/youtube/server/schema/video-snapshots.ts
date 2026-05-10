// youtube_video_snapshots — Phase 3.0 Plan 01.
//
// PUBLIC-DATA TABLE — no `user_id` column by design (CONTEXT D-07). Snapshot
// rows hold YouTube viewCount / likeCount / commentCount aggregated against
// `video_id`; the same numbers apply to every tenant who has an event for
// that video, so storing per-tenant copies would waste disk and burn quota
// for no privacy benefit. ESLint TENANT_TABLES allowlist extends the
// `youtubeVideoSnapshots` identifier with an explicit "public external data,
// no tenant scope" comment so the no-unfiltered-tenant-query rule does not
// trip on legitimate `db.select().from(youtubeVideoSnapshots)` calls.
//
// Worker write pattern (Plan 03.0-04): one row per successful poll, with
// `(video_id, polled_at)` UNIQUE making within-the-minute retries idempotent
// (`INSERT ... ON CONFLICT DO NOTHING`). `polled_at` is `date_trunc('minute',
// now())` at insert time so two retries inside the same minute collapse to
// one row. Counts are bigint (popular videos exceed 2^31) per RESEARCH.md.

import { pgTable, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const youtubeVideoSnapshots = pgTable(
  "youtube_video_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    videoId: text("video_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    viewCount: bigint("view_count", { mode: "number" }),
    likeCount: bigint("like_count", { mode: "number" }),
    commentCount: bigint("comment_count", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (video_id, polled_at) — UNIQUE index doubles as both the idempotency
    // guard for Plan 03.0-04's INSERT ON CONFLICT DO NOTHING retries AND
    // the read index the chart loader scans for "show last N points for
    // video X". A non-unique sibling on the same columns shipped in the
    // 0010 baseline alongside this; migration 0015 dropped it (paid two
    // B-tree updates per snapshot insert for no extra read coverage).
    videoPolledUnq: uniqueIndex("youtube_video_snapshots_video_polled_unq").on(
      t.videoId,
      t.polledAt,
    ),
  }),
);

export type YoutubeVideoSnapshot = typeof youtubeVideoSnapshots.$inferSelect;
export type NewYoutubeVideoSnapshot = typeof youtubeVideoSnapshots.$inferInsert;

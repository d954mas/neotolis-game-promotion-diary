// youtube_metadata_fetch_log — Phase 3.0 post-build review (2026-05-07).
//
// Per-user rolling 24h counter for cache-miss YouTube metadata fetches.
// One row per cache-miss invocation of services/youtube-metadata.ts ->
// fetchVideoMetadataByUrl (the "Get from YouTube" button on /events/new).
// quota.ts -> currentCount("youtube_metadata_fetches") counts rows where
// fetched_at > now() - 24h.
//
// Tenant-owned (carries user_id). The existing events_per_day cap counts
// rows in the events table — meaningless for a pre-event-form metadata
// pull. This table closes the operator-quota burn loop a scripted-loop
// caller could otherwise exploit on auth'd routes (the cap was claimed
// in a code comment but never enforced before this fix).
//
// FK on user_id with ON DELETE CASCADE means purgeAccount's user-row
// delete sweeps these rows automatically — no need to add an explicit
// entry to services/purge-account.ts.

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.js";

export const youtubeMetadataFetchLog = pgTable(
  "youtube_metadata_fetch_log",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Rolling-24h count + "most recent N for this user" — single index
    // pattern. Partial WHERE keeps the working set narrow.
    userAtIdx: index("idx_youtube_metadata_fetch_log_user_at").on(
      t.userId,
      sql`${t.fetchedAt} DESC`,
    ),
  }),
);

export type YoutubeMetadataFetchLog = typeof youtubeMetadataFetchLog.$inferSelect;
export type NewYoutubeMetadataFetchLog = typeof youtubeMetadataFetchLog.$inferInsert;

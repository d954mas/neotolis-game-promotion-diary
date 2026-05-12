// youtube_videos — our local copy of YouTube video metadata + polling
// state.
//
// One row per video, keyed on `video_id` (PK). PUBLIC-DATA — no `user_id`
// column by design. Identical across every tenant who ever references
// this video.
//
// Polling state lives here (not on `events`):
//   - `last_polled_at` / `last_poll_status` — last successful or failed
//     attempt to fetch this video's metrics from Google. Properties of the
//     VIDEO, not of the user-logged event. Multiple events referencing the
//     same external_id share this state via JOIN.
//   - `poll_failure_count` — increments on every non-ok poll, resets on
//     'ok'. Used by the rehab-unavailable cron to gate auto-retry: at
//     count >= 5 the video exits the rehab pool. Manual Refresh now still
//     works regardless of count (user intent overrides).
//
// Distinct from `youtube_video_snapshots` — that's the time-series stats
// table (many rows per video, one per poll). This table is mostly static
// for snippet fields (title rarely changes); polling state changes with
// every poll attempt; stats land in snapshots.
//
// Naming note: an earlier draft called this `youtube_video_metadata_cache`.
// "Cache" implies a regeneratable copy of some local truth, but this IS
// our truth — pulled from YouTube once and stored. The same misnomer
// applies to `youtube_channel_metadata_cache`; renaming that one is a
// separate refactor.
//
// Populated by:
//   - youtube-channel-context-backfill worker — initial seed on each
//     video discovered during a channel backfill.
//   - poll-active / poll-cold workers — UPDATE last_polled_at +
//     last_poll_status + poll_failure_count after each scheduler-driven
//     poll, plus snapshot append.
//   - poll-user worker — same UPDATE on Refresh now button.
//   - rehab-unavailable cron — same UPDATE on weekly retry of 'not_found'
//     videos with poll_failure_count < 5.
//   - fetch-metadata service (POST /api/youtube/fetch-metadata) on the
//     "Get from YouTube" button in /events/new — lookup-first; cache hit
//     returns directly (zero quota), cache miss writes here.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-tenant-
// query.js with the explicit "public external data, no tenant scope" comment.
//
// Retention contract:
//   Rows are NEVER garbage-collected, even when the last referencing event /
//   data_source has been deleted. Future channel-level analytics (median
//   views per channel, total reach, video count, publishing cadence) require
//   the FULL historical record across every video the system has ever seen.
//   The row IS the historical record for that channel's stats — discarding
//   orphan rows would make those analytics sparse and incorrect.
//   At indie-scale the table is bounded by O(seen-videos): years of
//   accumulation lands in the low single-digit GB range, comfortably within
//   Postgres + backup budgets. If table size becomes a real problem in the
//   future, the answer is partition or archive, NOT delete.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const youtubeVideos = pgTable(
  "youtube_videos",
  {
    videoId: text("video_id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    channelId: text("channel_id"),
    channelTitle: text("channel_title"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    // Polling state lives here (not on `events`). NULL on rows freshly
    // inserted by ingest before channel-context-backfill has fetched
    // stats.
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Scheduler tier filter — published_at is the load-bearing signal for
    // Active/Cold/Frozen classification. Partial index keeps it narrow over
    // the rare null-published rows (videos pre-backfill, the 'pending' tier).
    publishedAtIdx: index("idx_youtube_videos_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
    // Rehab cron — weekly walks 'not_found' / 'private' videos with
    // poll_failure_count < 5. Partial index narrows to the actual target set
    // so the cron's SELECT stays cheap as the cache grows.
    rehabIdx: index("idx_youtube_videos_rehab")
      .on(t.lastPolledAt)
      .where(sql`${t.lastPollStatus} IN ('not_found', 'private') AND ${t.pollFailureCount} < 5`),
  }),
);

export type YoutubeVideo = typeof youtubeVideos.$inferSelect;
export type NewYoutubeVideo = typeof youtubeVideos.$inferInsert;

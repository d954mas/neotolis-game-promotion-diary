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
//   - youtube-channel-context-backfill worker: initial seed on each video
//     discovered during a channel backfill.
//   - refresh queue worker: updates last_polled_at + last_poll_status +
//     poll_failure_count and appends snapshots.
//   - poll-active / poll-cold / rehab-unavailable enqueue service_video rows.
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
    // No `channel_title` column here — AGENTS.md no-denorm rule.
    // The channel display name lives on youtube_channels.channel_title
    // (FK via `channel_id`). feed-enrichment.ts JOINs at read time so a
    // channel rename in youtube_channels reflects everywhere immediately.
    // History: this column existed and was dropped in 0048; see
    // docs/denormalization-policy.md.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Short / full-video classification (user-locked 2026-06-12). Values:
    //   'short' — a YouTube Short (the redirect probe of
    //             youtube.com/shorts/<id> returned 200, OR the user pasted a
    //             /shorts/ URL — that paste IS the answer, no probe needed).
    //   'video' — a regular video (duration > 181s prefilter, OR the probe
    //             3xx-redirected to /watch).
    //   NULL    — unknown / not-yet-classified. EVERY existing prod row starts
    //             NULL and heals lazily as the poll worker touches it (the
    //             duration prefilter + per-tick-budgeted probe). NULL classifies
    //             as "video" downstream (the media-type filter's safe default —
    //             a YouTube video is a video at worst; never guessed into Short).
    //
    // WHY duration is ONLY a prefilter, not the decider: a ≤3min video CAN be a
    // regular (horizontal) video, not a Short. The DECIDER is the redirect probe
    // (server/shorts-probe.ts) which asks YouTube itself. Duration > 181s only
    // SKIPS the probe (such a video can never be a Short — Shorts are ≤3min).
    mediaType: text("media_type"),
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

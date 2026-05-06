// youtube_videos — Phase 3.0 post-build (UAT 2026-05-06).
//
// Our local copy of YouTube video metadata (title, description, channel id,
// channel title, published_at). One row per video, keyed on `video_id` (PK).
// PUBLIC-DATA — no `user_id` column by design. Identical across every tenant
// who ever references this video.
//
// Distinct from `youtube_video_snapshots` which is the time-series stats
// table (many rows per video, one per poll). This table is mostly static
// (a video's title can be edited by the uploader but rarely is); stats
// change continuously.
//
// Naming note: an earlier draft (UAT 2026-05-06) called this
// `youtube_video_metadata_cache`. "Cache" implies a regeneratable copy of
// some local truth, but this IS our truth — pulled from YouTube once and
// stored. The same misnomer applies to `youtube_channel_metadata_cache`;
// that one ships as the Phase 3.0 Plan 01 baseline and a rename is a
// separate refactor (4+ call sites, no payoff outside cleanliness).
//
// Populated by:
//   - youtube-channel-context-backfill worker (Plan 03.0-09 / 10) on
//     each video discovered during a channel backfill. The worker calls
//     videos.list?part=snippet,statistics — snippet lands here, statistics
//     lands in youtube_video_snapshots.
//   - fetch-metadata service (POST /api/youtube/fetch-metadata) on the
//     "Get from YouTube" button click in /events/new. Lookup-first: cache
//     hit → return directly (zero quota). Cache miss → API call (1 quota
//     unit) → write here → return.
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-tenant-
// query.js with the explicit "public external data, no tenant scope" comment.

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const youtubeVideos = pgTable("youtube_videos", {
  videoId: text("video_id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  channelId: text("channel_id"),
  channelTitle: text("channel_title"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type YoutubeVideo = typeof youtubeVideos.$inferSelect;
export type NewYoutubeVideo = typeof youtubeVideos.$inferInsert;

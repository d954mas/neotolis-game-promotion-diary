// tracked_youtube_videos — typed example for the per-platform tracked-item pattern (D-09).
//
// Per D-09: two users registering the same video_id produce two
// independent rows (different user_id). UNIQUE(user_id, video_id)
// prevents the same user from registering the same video twice.
//
// last_polled_at + last_poll_status are populated by the Phase 3
// worker; Phase 2 inserts NULL on both. UI surfaces "never polled"
// for null. last_poll_status enum (Phase 3): 'ok' | 'auth_error' |
// 'rate_limited' | 'not_found'. Phase 2 ships text-typed; Phase 3
// tightens to a check or pgEnum.
//
// Phase 3 scheduler scan optimization — DEFERRED.
//
// W-4 DECISION (Plan 02-03 checker iter 1; Option B): the partial index
// `idx_tracked_yt_videos_last_polled_at WHERE last_polled_at IS NOT NULL`
// does NOT land in Phase 2. Rationale:
//   - Phase 2 ships NO polling worker — `last_polled_at` is NULL on every
//     row inserted in P2. A partial index over an all-NULL column on day 1
//     adds bloat without query benefit.
//   - Drizzle 0.45 partial-index DSL support via `.where(sql`...`)` is
//     unverified for our locked version (RESEARCH.md Open Question 2);
//     deferring sidesteps the speculative DSL question entirely.
//   - Adding the index in Phase 3 (alongside the worker that uses it) is
//     the natural ship moment.
//
// Phase 3 backlog item (mirrored into ROADMAP Phase 3 entry by this plan):
//   "TODO Phase 3: add partial index `idx_tracked_yt_videos_last_polled_at`
//    WHERE last_polled_at IS NOT NULL (use raw SQL in a companion
//    migration if Drizzle 0.45 .where() on index() doesn't emit cleanly)."

import { pgTable, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { games } from "./games.js";
import { uuidv7 } from "../../ids.js";

export const trackedYoutubeVideos = pgTable(
  "tracked_youtube_videos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    channelId: text("channel_id"),
    authorUrl: text("author_url"),
    isOwn: boolean("is_own").notNull().default(false),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("tracked_youtube_videos_user_id_idx").on(t.userId),
    userGameIdx: index("tracked_youtube_videos_user_id_game_id_idx").on(t.userId, t.gameId),
    userVideoIdUnique: unique("tracked_youtube_videos_user_video_id_unq").on(t.userId, t.videoId),
  }),
);

// youtube_channels — typed example for the per-platform social-handle pattern (D-07).
//
// Lives at user level (NOT cascaded by game soft-delete per D-24). Two
// ways the user can paste a channel: (a) handle URL like
// https://youtube.com/@RickAstleyYT, (b) canonical channel URL like
// https://youtube.com/channel/UC.... handle_url is ALWAYS set (the user-
// pasted form); channel_id is set only if (b) was pasted OR a future
// resolver fetches the canonical id. INGEST-03 own/blogger lookup
// matches by handle_url against tracked_youtube_videos.author_url-
// derived handle (Pitfall 3 / Option C in RESEARCH.md).
//
// is_own: true => videos from this channel auto-mark as own; false =>
// blogger coverage. UI heuristic: first channel a user adds defaults
// to is_own=true, subsequent default false (UX-SPEC §"/accounts/youtube").

import { pgTable, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

export const youtubeChannels = pgTable(
  "youtube_channels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    handleUrl: text("handle_url").notNull(),
    channelId: text("channel_id"),
    displayName: text("display_name"),
    isOwn: boolean("is_own").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("youtube_channels_user_id_idx").on(t.userId),
    userHandleUnique: unique("youtube_channels_user_handle_unq").on(t.userId, t.handleUrl),
  }),
);

// game_youtube_channels — M:N link between games and youtube_channels (D-07).
//
// Soft-cascade with games: deleted_at inherits the parent games.deleted_at
// value in one tx (D-23). The underlying youtube_channels row is NOT
// cascaded (D-24) — channels live at user level and are reused.

import { pgTable, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { games } from "./games.js";
import { youtubeChannels } from "./youtube-channels.js";
import { uuidv7 } from "../../ids.js";

export const gameYoutubeChannels = pgTable(
  "game_youtube_channels",
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
    channelId: text("channel_id")
      .notNull()
      .references(() => youtubeChannels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("game_youtube_channels_user_id_idx").on(t.userId),
    gameIdx: index("game_youtube_channels_game_id_idx").on(t.gameId),
    gameChannelUnique: unique("game_youtube_channels_game_channel_unq").on(t.gameId, t.channelId),
  }),
);

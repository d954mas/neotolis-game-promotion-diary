// events — free-form timeline (D-27 separate from tracked_*_*).
//
// kind is a Postgres pgEnum (D-28) — closed picklist enforces invalid
// values fail at INSERT, not at "we'll fix it Tuesday". Drizzle 0.45 +
// drizzle-kit 0.31 emit CREATE TYPE + table CREATE in correct order
// when the enum is `export`-ed (drizzle-team/drizzle-orm#5174).
//
// url is optional — used for twitter/telegram URL ingest (D-29);
// notes is optional. occurred_at is the user-meaningful timestamp
// (when the talk / post / drop happened); created_at is the row
// insertion time.

import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { games } from "./games.js";
import { uuidv7 } from "../../ids.js";

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
export const eventKindEnum = pgEnum("event_kind", [
  "conference",
  "talk",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "press",
  "other",
]);

export const events = pgTable(
  "events",
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
    kind: eventKindEnum("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    url: text("url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("events_user_id_idx").on(t.userId),
    userGameOccurredIdx: index("events_user_id_game_id_occurred_at_idx").on(
      t.userId,
      t.gameId,
      t.occurredAt,
    ),
  }),
);

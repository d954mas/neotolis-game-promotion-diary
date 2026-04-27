// games table — GAMES-01..03, the parent of all per-game children.
//
// Pattern 1 (tenant scope): user_id FK + index. Every query in
// services/games.ts MUST include eq(games.userId, userId).
//
// Soft-delete: deleted_at timestamptz nullable; D-22 RETENTION_DAYS
// governs the purge window (Phase 3 worker). Soft-cascade: when a
// games row is deleted, all children share the same deleted_at value
// in one tx (D-23) so the restore can reverse exactly that set.
//
// tags is a text[] array column populated from Steam appdetails
// (genres + categories + steam_tags merged at game-listing-create
// time; the column on `games` carries the merged user-facing list).

import { pgTable, text, timestamp, date, boolean, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

export const games = pgTable(
  "games",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    coverUrl: text("cover_url"),
    releaseDate: date("release_date"),
    releaseTba: boolean("release_tba").notNull().default(false),
    tags: text("tags")
      .array()
      .notNull()
      .default([] as string[]),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("games_user_id_idx").on(t.userId),
    userCreatedIdx: index("games_user_id_created_at_idx").on(t.userId, t.createdAt),
    userDeletedIdx: index("games_user_id_deleted_at_idx").on(t.userId, t.deletedAt),
  }),
);

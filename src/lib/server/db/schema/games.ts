// games table — the parent of all per-game children.
//
// Tenant scope: user_id FK + index. Every query in services/games.ts
// MUST include eq(games.userId, userId).
//
// Soft-delete: deleted_at timestamptz nullable; the RETENTION_DAYS env
// governs the purge window. Soft-cascade: when a games row is deleted,
// all children share the same deleted_at value in one tx so the restore
// can reverse exactly that set.
//
// tags is a text[] array column populated from Steam appdetails
// (genres + categories + steam_tags merged at game-listing-create
// time; the column on `games` carries the merged user-facing list).
//
// `description` is a free-form long-text field for the user's per-game
// prose ("what's this game about, what's the pitch"). Nullable —
// empty/unset state is NULL, not an empty string, so the DTO can render
// `null` distinct from `""` if the future UI cares. Service layer
// enforces a 2000-char upper bound at validation time; the DB column
// has no length constraint to keep the migration purely additive.
//
// NO release_date / release_tba columns. Per AGENTS.md no-denormalization
// rule (denormalization-audit-2.md V-2): the release date is owned by
// `game_steam_listings.release_date`. Reproducing it on the games row
// produced stale values whenever Steam pushed a date change to a listing
// (the listing row updated but the games row rotted). The loader for
// /games + /games/[gameId] derives the effective release date from the
// non-deleted listings (earliest non-null release_date; TBA = at least
// one listing with NULL release_date). Migration drizzle/0047_*.sql
// dropped the two columns; GameDto still carries `releaseDate` / `releaseTba`
// at the wire level because the UI reads them under those names, but the
// SOURCE moved from the games row to the listings JOIN.

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
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
    tags: text("tags")
      .array()
      .notNull()
      .default([] as string[]),
    notes: text("notes").notNull().default(""),
    // Long-form per-game description (nullable). Service-layer cap:
    // 2000 chars (validated in updateGame). NULL distinguishes "never
    // set" from empty string — the DTO + UI honor the distinction so a
    // future polish pass can show "no description yet" copy without
    // breaking round-trips on rows that explicitly cleared their
    // description.
    description: text("description"),
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

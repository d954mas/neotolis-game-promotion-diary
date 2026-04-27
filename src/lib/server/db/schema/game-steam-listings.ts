// game_steam_listings — typed example for the per-store listing pattern (D-06, D-10).
//
// Multi-listing per game: a publisher's "HADES" entry can have a Demo
// app_id, a Full app_id, a DLC app_id, and a Soundtrack app_id all
// attached to the same logical games row. UNIQUE(game_id, app_id) and
// UNIQUE(user_id, app_id) prevent dupes both within a game and across
// games for the same user.
//
// api_key_id FK -> api_keys_steam.id is the "this listing's wishlist is
// polled by this Steamworks key" link (D-13). Nullable because P2 ships
// no polling worker — listings can exist before a key is saved; Phase 3
// backfills the FK when the user adds a key.
//
// raw_appdetails jsonb stores the full Steam appdetails response for
// forensics + future schema extraction (Phase 6 cache).

import { pgTable, text, timestamp, integer, jsonb, unique, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { games } from "./games.js";
import { apiKeysSteam } from "./api-keys-steam.js";
import { uuidv7 } from "../../ids.js";

export const gameSteamListings = pgTable(
  "game_steam_listings",
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
    appId: integer("app_id").notNull(),
    label: text("label").notNull().default(""),
    coverUrl: text("cover_url"),
    releaseDate: text("release_date"),
    comingSoon: text("coming_soon"),
    steamGenres: text("steam_genres")
      .array()
      .notNull()
      .default([] as string[]),
    steamCategories: text("steam_categories")
      .array()
      .notNull()
      .default([] as string[]),
    rawAppdetails: jsonb("raw_appdetails"),
    apiKeyId: text("api_key_id").references(() => apiKeysSteam.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("game_steam_listings_user_id_idx").on(t.userId),
    gameIdx: index("game_steam_listings_game_id_idx").on(t.gameId),
    gameAppIdUnique: unique("game_steam_listings_game_app_id_unq").on(t.gameId, t.appId),
    userAppIdUnique: unique("game_steam_listings_user_app_id_unq").on(t.userId, t.appId),
  }),
);

// game_steam_listings — per-store listing pattern.
//
// Multi-listing per game: a publisher's "HADES" entry can have a Demo
// app_id, a Full app_id, a DLC app_id, and a Soundtrack app_id all
// attached to the same logical games row. UNIQUE(game_id, app_id)
// prevents dupes within a game; the same Steam appId is allowed across
// multiple games of the same user. The constraint is unconditional —
// soft-deleted-same-game re-add is caught by the service-layer
// pre-INSERT lookup, which surfaces a "restore the soft-deleted
// listing" UX before the INSERT hits 23505.
//
// api_key_id FK -> api_keys_steam.id is the "this listing's wishlist is
// polled by this Steamworks key" link. Nullable because no polling
// worker ships today — listings can exist before a key is saved; a
// future worker backfills the FK when the user adds a key.
//
// raw_appdetails jsonb stores the full Steam appdetails response for
// forensics + future schema extraction.

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
    // Steam game name persisted from fetchSteamAppDetails. Nullable —
    // legacy rows + Steam-down inserts keep NULL; SteamListingRow
    // renders `App {appId}` fallback when null.
    name: text("name"),
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
  }),
);

// wishlist_snapshots — tenant-scoped daily Steam wishlist time-series.
//
// D-06 CONTRAST (load-bearing): this is the OPPOSITE of
// youtube_video_snapshots. YouTube view counts are public-data shared
// across tenants (no user_id, in the ESLint ALLOWLIST). Wishlist counts
// are commercially-sensitive per-user financial-adjacent data — a leak
// here exposes a dev's pre-launch health to competitors. Therefore this
// table:
//   - carries user_id and is TENANT-scoped,
//   - goes in ESLint TENANT_TABLES, NEVER the public-data allowlist,
//   - is queried only with eq(wishlistSnapshots.userId, userId),
//   - returns 404 (not 403) on cross-tenant access.
//
// NO DENORMALIZATION: do NOT copy the listing `name` / CSV `Game` column
// onto these rows. The game/listing display name is owned by
// game_steam_listings — read it via the listingId FK, never cache it here
// (AGENTS.md no-denormalization rule).

import { pgTable, text, integer, date, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { gameSteamListings } from "./game-steam-listings.js";
import { uuidv7 } from "../../ids.js";

export const wishlistSnapshots = pgTable(
  "wishlist_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    listingId: text("listing_id")
      .notNull()
      .references(() => gameSteamListings.id, { onDelete: "cascade" }),
    date: date("date").notNull(), // DateLocal (Pacific calendar day)
    // Daily wishlist-activity components. NOT NULL: the only writer (CSV
    // import) always supplies integers, so the balance recompute SUM is
    // non-NULL by construction. `source` discriminates provenance for the
    // roadmap manual/api writers, which will likewise supply all four.
    adds: integer("adds").notNull(),
    deletes: integer("deletes").notNull(),
    purchasesAndActivations: integer("purchases_and_activations").notNull(),
    gifts: integer("gifts").notNull(),
    balance: integer("balance").notNull(), // derived outstanding wishlists; always present
    source: text("source").notNull().default("csv"), // forward-compat 'manual'/'api' (D-02/D-05); NOT in conflict key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("wishlist_snapshots_user_id_idx").on(t.userId),
    // (listing_id, date) UNIQUE — NO source in the key (D-05). Idempotency guard
    // for ON CONFLICT DO UPDATE + read index for "last N days for listing X".
    // A listing belongs to exactly one user, so this can never collide across tenants.
    listingDateUnq: uniqueIndex("wishlist_snapshots_listing_date_unq").on(t.listingId, t.date),
  }),
);

export type WishlistSnapshot = typeof wishlistSnapshots.$inferSelect;
export type NewWishlistSnapshot = typeof wishlistSnapshots.$inferInsert;

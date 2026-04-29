// event_games — M:N junction enabling multi-game attachment per event.
//
// Plan 02.1-27 (UAT-NOTES.md §4.24.G): replaces the Phase 2.1 events.game_id
// FK with a true many-to-many relation. user_id is DENORMALIZED so the
// ESLint tenant-scope rule can require an eq(eventGames.userId, userId)
// filter on every Drizzle query — the rule cannot inspect FK-chained values.
// The denorm carries minor write-time consistency cost (insert paths must
// pass user_id along with event_id + game_id) which is enforced by the
// service-layer attachEventToGames signature in Plan 02.1-28.
//
// Composite PK (event_id, game_id) prevents duplicate attachments of the
// same game to the same event. Cross-tenant attempts surface as
// NotFoundError 404 by construction (the userId WHERE clause yields zero
// rows; the post-INSERT/UPDATE !row check throws).

import { pgTable, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { events } from "./events.js";
import { games } from "./games.js";

export const eventGames = pgTable(
  "event_games",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.gameId] }),
    userIdx: index("event_games_user_id_idx").on(t.userId),
    gameIdx: index("event_games_game_id_idx").on(t.gameId),
    userGameIdx: index("event_games_user_game_idx").on(t.userId, t.gameId),
  }),
);

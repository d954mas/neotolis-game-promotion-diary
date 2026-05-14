// reddit_pacer — single-row global rate-limit token table.
//
// Owns the "next allowed Reddit HTTP request" timestamp. Every redditFetch
// call atomically reads + bumps this row BEFORE its network call (see
// pacer.ts acquireRedditPacerSlot). Sync user paths (preview, paste
// Submit) and the async 8-tick worker share the same token so the
// 10 req/min Reddit ceiling is enforced ONCE, globally, regardless of
// how many concurrent browser sessions exist.
//
// `id` is constrained to 1 via CHECK ("id" = 1) — there is exactly one
// pacer row at any time. The boot SQL INSERTs the row on first migrate;
// the application code never INSERTs or DELETEs.

import { pgTable, smallint, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const redditPacer = pgTable("reddit_pacer", {
  id: smallint("id").primaryKey().default(1),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
});

export type RedditPacerRow = typeof redditPacer.$inferSelect;

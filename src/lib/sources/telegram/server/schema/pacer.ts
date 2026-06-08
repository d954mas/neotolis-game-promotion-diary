// telegram_pacer — single-row global rate-limit token table.
//
// Owns the "next allowed Telegram HTTP request" timestamp. Every telegramFetch
// call atomically reads + bumps this row BEFORE its network call (Plan 03
// pacer.ts acquireTelegramPacerSlot). Sync user paths (preview, paste Submit)
// and the async listing-poll / warm lane workers share the same token so the
// Telegram politeness ceiling is enforced ONCE, globally, regardless of how
// many concurrent browser sessions exist (mirrors reddit_pacer).
//
// `id` is constrained to 1 via CHECK ("id" = 1) — there is exactly one pacer
// row at any time. The boot SQL INSERTs the row on first migrate; the
// application code never INSERTs or DELETEs.

import { check, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const telegramPacer = pgTable(
  "telegram_pacer",
  {
    id: smallint("id").primaryKey().default(1),
    nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pauseLevel: smallint("pause_level").notNull().default(0),
    lastPauseReason: text("last_pause_reason"),
    lastPausedAt: timestamp("last_paused_at", { withTimezone: true }),
  },
  (t) => ({
    lastPauseReasonCheck: check(
      "telegram_pacer_last_pause_reason_check",
      sql`${t.lastPauseReason} IS NULL OR ${t.lastPauseReason} IN ('http_403', 'http_429')`,
    ),
  }),
);

export type TelegramPacerRow = typeof telegramPacer.$inferSelect;

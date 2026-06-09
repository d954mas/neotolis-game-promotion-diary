// telegram_post_snapshots — views-only time-series for Telegram channel posts.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Snapshot rows hold the
// Telegram view count aggregated against `post_id`; the same number applies to
// every tenant who has an event for that post, so storing per-tenant copies
// would waste disk for no privacy benefit. ESLint TENANT_TABLES allowlist
// extends `telegramPostSnapshots` with an explicit "public external data, no
// tenant scope (time-series)" comment (added in Plan 01) so the
// no-unfiltered-tenant-query rule does not trip on legitimate
// `db.select().from(telegramPostSnapshots)` calls.
//
// Mirrors youtube_video_snapshots / instagram_post_snapshots. Worker write
// pattern: one row per successful poll, with `(post_id, polled_at)` UNIQUE
// making within-the-minute retries idempotent (`INSERT ... ON CONFLICT DO
// NOTHING`). `polled_at` is `date_trunc('minute', now())` at insert time so two
// retries inside the same minute collapse to one row.
//
// Telegram exposes a view count AND a per-post reaction tally on the public
// t.me/s LISTING (the reactions block is absent from the ?embed=1 single-post
// page). `view_count` is bigint (channels exceed 2^31 views — 14M seen live)
// and is null when the post hides views (very new / views disabled) → excluded
// from the chart. `reactions_total` (E1 — Phase 9 UAT second metric) is the
// summed count across every reaction kind (standard emoji + custom/premium
// stickers + paid Telegram-Stars), parallel to view_count: bigint, null when
// the post carries no reactions block (→ chart GAP, never coerced to 0, the
// metric-series reader drops an all-null reactions line — D-05).
//
// Deep-history backfill yields a CURRENT snapshot of old posts, NOT historical
// trends — per-post time-series accrues only from when tracking starts.

import { pgTable, text, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "$lib/server/ids.js";

export const telegramPostSnapshots = pgTable(
  "telegram_post_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    postId: text("post_id").notNull(),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    // bigint — channels exceed 2^31 views (14M seen live). null when the
    // post hides views (very new / views disabled) → excluded from chart.
    viewCount: bigint("view_count", { mode: "number" }),
    // bigint — summed reaction count across all kinds (E1, second metric). null
    // when the post has no reactions block → excluded from chart (D-05 GAP).
    // Popular posts exceed 2^31 reactions in aggregate, so bigint like views.
    reactionsTotal: bigint("reactions_total", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (post_id, polled_at) — UNIQUE index doubles as both the idempotency
    // guard for INSERT ON CONFLICT DO NOTHING retries AND the read index the
    // chart loader scans for "show last N points for post X".
    postPolledUnq: uniqueIndex("telegram_post_snapshots_post_polled_unq").on(t.postId, t.polledAt),
  }),
);

export type TelegramPostSnapshot = typeof telegramPostSnapshots.$inferSelect;
export type NewTelegramPostSnapshot = typeof telegramPostSnapshots.$inferInsert;

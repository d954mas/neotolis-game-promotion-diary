// twitter_pacer — single-row global QPS-pacer token table.
//
// twitterapi.io rate-limits PER API KEY (0.2 QPS for a never-paid account =
// 1 request / 5s; 3 QPS after the first top-up). That ceiling is shared across
// EVERY twitterapi.io call: backfill (initial / cron / continuation), the warm
// refresh lane, and the paste/preview path — and across replicas. Every
// twitterFetch acquires this single DB-backed token (acquireTwitterPacerSlot in
// ../pacer.ts) BEFORE its network call so the global request rate never crosses
// the floor, regardless of how many concurrent workers/browser sessions exist.
//
// Mirrors reddit_pacer (the precedent) MINUS the escalating pause columns:
// twitter's 429 is a transient per-account QPS ceiling already handled by the
// http seam's retryAfterMs self-resume — the pacer is only the PROACTIVE slot
// gate, so a single next_allowed_at suffices.
//
// `id` is constrained to 1 via the PK default — there is exactly one pacer row.
// The boot/migration SQL INSERTs it; the application code never INSERTs/DELETEs.

import { check, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const twitterPacer = pgTable(
  "twitter_pacer",
  {
    id: smallint("id").primaryKey().default(1),
    nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => ({
    singleRowCheck: check("twitter_pacer_id_check", sql`${t.id} = 1`),
  }),
);

export type TwitterPacerRow = typeof twitterPacer.$inferSelect;

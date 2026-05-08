// youtube_service_quota_usage — Phase 3.0 Plan 01.
//
// OPERATOR-SIDE COUNTER — no `user_id` column by design (CONTEXT D-13).
// YouTube Data API v3 quota is service-level (per API key, per Pacific
// calendar day), not per-tenant. The poller increments this row in the
// same transaction as a snapshot insert (Plan 03.0-04) so the counter
// can never disagree with the work that consumed quota.
//
// Composite PK `(date_pacific, api_key_id)`:
//   - `date_pacific`: YYYY-MM-DD in America/Los_Angeles (Google's quota
//     reset boundary). Stored as Postgres `date` to avoid TZ confusion.
//   - `api_key_id`: sha-8 of the API key string (operator may rotate keys
//     mid-day; each gets its own counter row).
//
// Plan 03.0-09's `youtube.quota_reset` cron runs at 00:01 Pacific daily
// to seed the new day's row at zero (UPSERT with ON CONFLICT DO NOTHING).
// Old rows are kept ~7 days for audit, then truncated by the same cron.
// ESLint TENANT_TABLES allowlist includes this table with an explicit
// "operator-side counter, no tenant scope" comment.

import { pgTable, text, integer, date, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const youtubeServiceQuotaUsage = pgTable(
  "youtube_service_quota_usage",
  {
    datePacific: date("date_pacific").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    estimatedUnits: integer("estimated_units").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datePacific, t.apiKeyId] }),
  }),
);

export type YoutubeServiceQuotaUsage = typeof youtubeServiceQuotaUsage.$inferSelect;
export type NewYoutubeServiceQuotaUsage = typeof youtubeServiceQuotaUsage.$inferInsert;

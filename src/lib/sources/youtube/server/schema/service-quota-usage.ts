// youtube_service_quota_usage.
//
// OPERATOR-SIDE COUNTER вЂ” no `user_id` column by design. YouTube Data API
// v3 quota is service-level (per API key, per Pacific calendar day), not
// per-tenant. Runtime code reserves units in this table before upstream
// HTTP so the daily budget is shared safely across worker replicas.
//
// Composite PK `(date_pacific, api_key_id, pool_kind)`:
//   - `date_pacific`: YYYY-MM-DD in America/Los_Angeles (Google's quota
//     reset boundary). Stored as Postgres `date` to avoid TZ confusion.
//   - `api_key_id`: sha-8 of the API key string (operator may rotate keys
//     mid-day; each gets its own counter row).
//   - pool_kind: 'cron' | 'user' - origin pool attribution.
//
// The `youtube.quota_reset` cron runs at 00:01 Pacific daily to seed the
// new day's row at zero (UPSERT with ON CONFLICT DO NOTHING). Old rows
// are kept ~7 days for audit, then truncated by the same cron. ESLint
// TENANT_TABLES allowlist includes this table with an explicit
// "operator-side counter, no tenant scope" comment.

import { pgTable, text, integer, date, timestamp, primaryKey } from "drizzle-orm/pg-core";

export type QuotaPoolKind = "cron" | "user";

export const youtubeServiceQuotaUsage = pgTable(
  "youtube_service_quota_usage",
  {
    datePacific: date("date_pacific").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    poolKind: text("pool_kind").$type<QuotaPoolKind>().notNull(),
    estimatedUnits: integer("estimated_units").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datePacific, t.apiKeyId, t.poolKind] }),
  }),
);

export type YoutubeServiceQuotaUsage = typeof youtubeServiceQuotaUsage.$inferSelect;
export type NewYoutubeServiceQuotaUsage = typeof youtubeServiceQuotaUsage.$inferInsert;

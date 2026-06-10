// social_provider_spend + social_provider_balance.
//
// OPERATOR-SIDE COST GUARDRAIL — no `user_id` column by design. Social
// provider credits (ScrapeCreators today) are a service-level prepaid pool,
// not a per-tenant resource. Two DISTINCT concepts live here, and conflating
// them is the load-bearing Pitfall 3:
//
//   1. social_provider_spend — the DAILY-CAP counter. `credits_used` keyed by
//      (date_pacific, platform, provider, pool_kind). Gates the 80/95 throttle
//      and RESETS every Pacific day via the instagram.quota_reset cron (mirror
//      youtube_service_quota_usage's daily-reset semantics).
//
//   2. social_provider_balance — the PREPAID BALANCE. A single running number
//      per PROVIDER (the real prepaid account), SHARED across all platforms
//      (Instagram + TikTok both draw from the one ScrapeCreators account, D-01 /
//      RESEARCH Q1 Option (b)). Decremented on EVERY spend, and NEVER reset by
//      the cron. This is the absolute "cannot spend what isn't there" ceiling
//      (D-16). The reset cron clears ONLY the daily counter; it MUST NOT touch
//      this balance. Seeded from env.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS on
//      first spend (UPSERT). Per-platform spend VISIBILITY survives on
//      social_provider_spend (the daily counter keeps its platform column) — a
//      single shared ceiling, still attributable per-platform for /admin/quota.
//
// Both tables are in the ESLint TENANT_TABLES allowlist (Plan 01) with the
// explicit "operator-side, no tenant scope" comment.

import { pgTable, text, integer, date, timestamp, primaryKey } from "drizzle-orm/pg-core";

export type SocialQuotaPoolKind = "cron" | "user";

// The DAILY-CAP counter — resets each Pacific day via the quota_reset cron.
export const socialProviderSpend = pgTable(
  "social_provider_spend",
  {
    datePacific: date("date_pacific").notNull(),
    platform: text("platform").notNull(),
    provider: text("provider").notNull(),
    poolKind: text("pool_kind").$type<SocialQuotaPoolKind>().notNull(),
    creditsUsed: integer("credits_used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datePacific, t.platform, t.provider, t.poolKind] }),
  }),
);

// The PREPAID BALANCE — a single running ceiling per PROVIDER, SHARED across
// every platform that draws from that provider's real prepaid account (IG +
// TikTok both spend the one ScrapeCreators balance, D-01 / RESEARCH Q1 Option
// (b)). NEVER reset by the daily-cap cron (Pitfall 3). Monotonically
// decremented on every spend; reservation returns null once it drops below the
// units requested ("cannot spend what isn't there", D-16). The `platform`
// column lives only on social_provider_spend (the daily counter) — keeping
// per-platform spend visibility — NOT here, so two platforms cannot each carve
// out an independent ceiling (the Pitfall 3 double-count).
export const socialProviderBalance = pgTable(
  "social_provider_balance",
  {
    provider: text("provider").notNull(),
    prepaidBalanceCredits: integer("prepaid_balance_credits").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider] }),
  }),
);

export type SocialProviderSpend = typeof socialProviderSpend.$inferSelect;
export type NewSocialProviderSpend = typeof socialProviderSpend.$inferInsert;
export type SocialProviderBalance = typeof socialProviderBalance.$inferSelect;
export type NewSocialProviderBalance = typeof socialProviderBalance.$inferInsert;

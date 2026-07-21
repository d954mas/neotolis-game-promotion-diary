// Reddit (ScrapeCreators) observability surface (clone of twitter/server/
// observability.ts, retargeted to platform "reddit" / provider "scrapecreators").
//
// Implements the per-adapter AdapterObservability the cross-source /admin/quota
// dashboard reads. Wired to the SHARED prepaid-credit budget engine (quota.ts
// re-export — the SAME social_provider_* tables + the SAME ScrapeCreators balance
// row IG + TikTok draw from, keyed by PROVIDER="scrapecreators", D-01). Unlike
// twitterapi.io (its own per-provider balance row), Reddit is the 4th consumer of
// the shared ScrapeCreators pool:
//
//   - auth.kind = "scrape" (no per-user secrets; operator-configured via the shared
//     ScrapeCreators key + REDDIT_PROVIDER). ★ isOperatorConfigured comes from
//     isRedditConfigured() — the D-08 KILL-SWITCH gate (REDDIT_IMPORT_ENABLED checked
//     FIRST as an independent AND-term, so the shared key alone does NOT auto-enable
//     Reddit). This is the SOC-05 not-configured signal surfaced to the add-source
//     chip + /admin/quota.
//   - quota.getDailyStats(date) — projects today's social_provider_spend (reddit
//     platform counter) + shared prepaid balance into ObservabilityDailyStats.
//   - quota.getRecentAudit(limit) — last N social.* throttle/budget audit rows scoped
//     to metadata.platform = 'reddit' (the per-platform audit scope).
//   - userQuotaCap.requestsPerDay = env.LIMIT_SOCIAL_REQUESTS_PER_DAY.
//   - getRedditProviderBlock() — the additive /admin/quota block for Plan 06's read.
//
// CREDIT-UNIT (12-SPIKE Q5 / D-01): internal credit = ONE provider request
// (creditsUsed:1/page), the ScrapeCreators native billing unit, so the 80/95
// throttle + daily cap + prepaid balance count REQUESTS uniformly across IG/TikTok/
// Reddit. USD_PER_REQUEST (~$0.002/credit; full 17-post backfill = 3 credits) is the
// ONE source of truth in http.ts; the costEstimateUsd projection multiplies it by
// requests used. Because Reddit SHARES the ScrapeCreators balance, prepaidBalance
// here is the SAME pool IG/TikTok report — not a Reddit-private ceiling.

import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";
import { isRedditConfigured } from "./provider/registry.js";
import { getSocialSpendToday, getSocialThrottleState, type SocialThrottleState } from "./quota.js";
// Real-dollar cost of ONE provider request (12-SPIKE Q5) — ONE source of truth in
// http.ts; the costEstimateUsd projection multiplies it by requests used.
import { USD_PER_REQUEST } from "./http.js";

const PLATFORM = "reddit";
const PROVIDER = "scrapecreators";

/**
 * Project today's prepaid-credit spend + balance into the cross-source
 * ObservabilityDailyStats shape. The single "key" is the provider (the shared
 * ScrapeCreators key), so the keys[] array carries exactly one entry mirroring the
 * aggregate. `throttleState` is the adapter's own classification.
 */
async function getDailyStats(date: Date): Promise<ObservabilityDailyStats> {
  const { creditsUsed, dailyCap } = await getSocialSpendToday(PLATFORM, PROVIDER, date);
  const throttleState = await getSocialThrottleState(PLATFORM, PROVIDER, date);
  const pctOfDaily = dailyCap > 0 ? creditsUsed / dailyCap : 0;
  return {
    unitsUsed: creditsUsed,
    dailyLimit: dailyCap,
    pctOfDaily,
    throttleState,
    keys: [{ apiKeyId: PROVIDER, unitsUsed: creditsUsed, throttleState }],
    costEstimateUsd: creditsUsed * USD_PER_REQUEST,
  };
}

/**
 * Social-provider audit verbs surfaced on /admin/quota's Reddit tab. The shared
 * budget engine emits social.provider_throttled (80/95 crossing) and
 * social.budget_exhausted (prepaid balance hit 0) under the operator's user_id.
 */
const SOCIAL_AUDIT_ACTIONS = ["social.budget_exhausted", "social.provider_throttled"] as const;

/**
 * Last N social.* audit rows ordered by createdAt DESC, scoped to
 * metadata.platform = 'reddit'. Cross-tenant aggregation by design: /admin/quota is
 * operator-facing (allowlist-gated upstream). The verbs are system-emitted under the
 * operator's resolved user_id. The IG/TikTok/Twitter twins carry the mirror filter so
 * each provider tab only surfaces its own rows.
 */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors instagram/tiktok/twitter/youtube getRecentAudit.
  const rows = await db
    .select({
      action: auditLog.action,
      occurredAt: auditLog.createdAt,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, [...SOCIAL_AUDIT_ACTIONS]),
        sql`${auditLog.metadata}->>'platform' = ${PLATFORM}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    action: r.action,
    occurredAt: r.occurredAt,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** The /admin/quota Reddit block (Plan 06). Surfaces both the daily-cap view
 *  (requestsToday vs dailyCap) AND the funded view (prepaidBalance — the absolute
 *  remaining ScrapeCreators balance, SHARED with IG/TikTok, NOT a Reddit-private
 *  ceiling) plus the configured / throttle signals. */
export interface RedditProviderBlock {
  isConfigured: boolean;
  requestsToday: number;
  creditsUsed: number;
  dailyCap: number;
  remainingBalance: number;
  prepaidBalance: number;
  throttleState: SocialThrottleState;
}

export async function getRedditProviderBlock(now: Date = new Date()): Promise<RedditProviderBlock> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    PLATFORM,
    PROVIDER,
    now,
  );
  const throttleState = await getSocialThrottleState(PLATFORM, PROVIDER, now);
  return {
    isConfigured: isRedditConfigured(),
    // One credit per request ⇒ requests today == credits used today.
    requestsToday: creditsUsed,
    creditsUsed,
    dailyCap,
    remainingBalance: prepaidBalance,
    prepaidBalance,
    throttleState,
  };
}

/**
 * redditObservability — surface composed into redditAdapter via the barrel (Plan 05
 * index.ts). ★ isOperatorConfigured is a GETTER so it is evaluated at READ time via
 * isRedditConfigured() — the D-08 kill-switch gate (REDDIT_IMPORT_ENABLED === "true"
 * AND REDDIT_PROVIDER === "scrapecreators" AND the shared key set). This composes the
 * isolation gate into the adapter, matching the CHECKLIST "runtime-evaluated"
 * contract: a mere IG/TikTok configuration does NOT flip Reddit on.
 */
export const redditObservability: AdapterObservability = {
  auth: {
    kind: "scrape",
    requiresUserSetup: false,
    get isOperatorConfigured(): boolean {
      return isRedditConfigured();
    },
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // Per-user fair-share cap on the operator's prepaid pool. The 429 enforcement via
  // enforceAdapterUserQuota runs in fetchEventPreviewMetadata.
  userQuotaCap: {
    requestsPerDay: env.LIMIT_SOCIAL_REQUESTS_PER_DAY,
  },
  // The prepaid balance + daily counter live in social_provider_* under row locks
  // (quota.ts reserveSocialCredits FOR UPDATE), so the adapter needs no singleton
  // runtime — multi-replica workers are clean-safe.
  requiresSingletonRuntime: false,
};

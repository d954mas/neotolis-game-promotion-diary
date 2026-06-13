// Twitter/X (twitterapi.io) observability surface (clone of tiktok/server/
// observability.ts, retargeted to platform "twitter" / provider "twitterapi.io").
//
// Implements the per-adapter AdapterObservability the cross-source /admin/quota
// dashboard reads. Retargeted to the SHARED prepaid-credit budget engine (quota.ts
// re-export — the same social_provider_* tables IG/TikTok use, keyed by PROVIDER so
// twitterapi.io gets its OWN balance row, D-02):
//
//   - auth.kind = "scrape" (no per-user secrets; operator-configured via the
//     twitterapi.io key + TWITTER_PROVIDER). isOperatorConfigured comes from the
//     twitter registry check (isTwitterConfigured) — the SOC-05 not-configured signal.
//   - quota.getDailyStats(date) — projects today's social_provider_spend (twitter
//     platform counter) + prepaid balance into ObservabilityDailyStats.
//   - quota.getRecentAudit(limit) — last N social.* throttle/budget audit rows
//     scoped to metadata.platform = 'twitter' (the per-platform audit scope).
//   - userQuotaCap.requestsPerDay = env.LIMIT_SOCIAL_REQUESTS_PER_DAY.
//   - getTwitterProviderBlock() — the additive /admin/quota block for Plan 04's read.
//
// CREDIT-UNIT (11-SPIKE.md Q5 / Plan 02): internal credit = ONE provider request
// (creditsUsed:1/page), exactly like ScrapeCreators, so the 80/95 throttle + daily
// cap + prepaid balance count REQUESTS uniformly across both vendors. twitterapi.io
// bills per RETURNED TWEET (15 credits/tweet in their 100k-per-$1 unit); the real
// dollar cost of one request (~$0.003 for a 20-tweet page) is the USD_PER_REQUEST
// note below, NOT a reservation amount.

import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";
import { isTwitterConfigured } from "./provider/registry.js";
import { getSocialSpendToday, getSocialThrottleState, type SocialThrottleState } from "./quota.js";
// Real-dollar cost of ONE provider request (11-SPIKE.md Q5) — ONE source of truth
// in http.ts; the costEstimateUsd projection multiplies it by requests used.
import { USD_PER_REQUEST } from "./http.js";

const PLATFORM = "twitter";
const PROVIDER = "twitterapi.io";

/**
 * Project today's prepaid-credit spend + balance into the cross-source
 * ObservabilityDailyStats shape. The single "key" is the provider (one operator
 * twitterapi.io key), so the keys[] array carries exactly one entry mirroring the
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
 * Social-provider audit verbs surfaced on /admin/quota's Twitter tab. The shared
 * budget engine emits social.provider_throttled (80/95 crossing) and
 * social.budget_exhausted (prepaid balance hit 0) under the operator's user_id.
 */
const SOCIAL_AUDIT_ACTIONS = ["social.budget_exhausted", "social.provider_throttled"] as const;

/**
 * Last N social.* audit rows ordered by createdAt DESC, scoped to
 * metadata.platform = 'twitter'. Cross-tenant aggregation by design: /admin/quota is
 * operator-facing (allowlist-gated upstream). The verbs are system-emitted under the
 * operator's resolved user_id. The IG/TikTok twins carry the mirror filter so each
 * provider tab only surfaces its own rows.
 */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors instagram/tiktok/reddit/youtube getRecentAudit.
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

/** The /admin/quota Twitter block (Plan 04). Surfaces both the daily-cap view
 *  (requestsToday vs dailyCap) AND the funded view (prepaidBalance — the absolute
 *  remaining twitterapi.io balance, the D-02 hard ceiling, SEPARATE from the
 *  ScrapeCreators pool) plus the configured / throttle signals. */
export interface TwitterProviderBlock {
  isConfigured: boolean;
  requestsToday: number;
  creditsUsed: number;
  dailyCap: number;
  remainingBalance: number;
  prepaidBalance: number;
  throttleState: SocialThrottleState;
}

export async function getTwitterProviderBlock(now: Date = new Date()): Promise<TwitterProviderBlock> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    PLATFORM,
    PROVIDER,
    now,
  );
  const throttleState = await getSocialThrottleState(PLATFORM, PROVIDER, now);
  return {
    isConfigured: isTwitterConfigured(),
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
 * twitterObservability — surface composed into twitterAdapter via the barrel
 * (index.ts). isOperatorConfigured is a GETTER so it is evaluated at READ time via
 * the registry check (TWITTER_PROVIDER === "twitterapi.io" && TWITTERAPIIO_API_KEY
 * !== ""), matching the CHECKLIST "runtime-evaluated" contract.
 */
export const twitterObservability: AdapterObservability = {
  auth: {
    kind: "scrape",
    requiresUserSetup: false,
    get isOperatorConfigured(): boolean {
      return isTwitterConfigured();
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

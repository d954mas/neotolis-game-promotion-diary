// TikTok (ScrapeCreators) observability surface (clone of instagram/server/
// observability.ts, retargeted to platform "tiktok").
//
// Implements the per-adapter AdapterObservability the cross-source /admin/quota
// dashboard reads. Retargeted to the SHARED prepaid-credit budget engine
// (quota.ts re-export — the same social_provider_* tables IG uses, keyed by
// provider so IG+TikTok share one ceiling, D-01):
//
//   - auth.kind = "scrape" (no per-user secrets; operator-configured via the
//     ScrapeCreators key + TIKTOK_PROVIDER). isOperatorConfigured comes from the
//     tiktok registry check (isTikTokConfigured) — the SOC-05 not-configured signal.
//   - quota.getDailyStats(date) — projects today's social_provider_spend (tiktok
//     platform counter) + prepaid balance into ObservabilityDailyStats.
//   - quota.getRecentAudit(limit) — last N social.* throttle/budget audit rows.
//   - userQuotaCap.requestsPerDay = env.LIMIT_SOCIAL_REQUESTS_PER_DAY.
//   - getTikTokProviderBlock() — the additive /admin/quota block (counts +
//     spend/cap + remaining balance) for Plan 05's read.

import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";
import { isTikTokConfigured } from "./provider/registry.js";
import { getSocialSpendToday, getSocialThrottleState, type SocialThrottleState } from "./quota.js";

const PLATFORM = "tiktok";
const PROVIDER = "scrapecreators";

/** ScrapeCreators list price: $2 / 1000 credits = $0.002 per credit (1 credit per
 *  request). Informational cost estimate only. */
const USD_PER_CREDIT = 0.002;

/**
 * Project today's prepaid-credit spend + balance into the cross-source
 * ObservabilityDailyStats shape. The single "key" is the provider (one operator
 * ScrapeCreators key), so the keys[] array carries exactly one entry mirroring the
 * aggregate. `throttleState` is the adapter's own classification — consumers do
 * NOT recompute.
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
    costEstimateUsd: creditsUsed * USD_PER_CREDIT,
  };
}

/**
 * Social-provider audit verbs surfaced on /admin/quota's TikTok tab. The shared
 * budget engine emits social.provider_throttled (80/95 crossing) and
 * social.budget_exhausted (prepaid balance hit 0) under the operator's user_id.
 */
const SOCIAL_AUDIT_ACTIONS = ["social.budget_exhausted", "social.provider_throttled"] as const;

/**
 * Last N social.* audit rows ordered by createdAt DESC. Cross-tenant aggregation
 * by design: /admin/quota is operator-facing (allowlist-gated upstream). The verbs
 * are system-emitted under the operator's resolved user_id.
 */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // The social.* verbs are emitted for EVERY ScrapeCreators platform (IG +
  // TikTok share the same audit actions), so the TikTok tab must only surface
  // rows with metadata.platform = 'tiktok' (the 10-04 plan's per-platform audit
  // scope). The Instagram twin carries the mirror filter.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors instagram/reddit/youtube getRecentAudit.
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

/** The /admin/quota TikTok block (Plan 05). Surfaces both the daily-cap view
 *  (requestsToday vs dailyCap) AND the funded view (prepaidBalance — the absolute
 *  remaining, the D-16 hard ceiling shared with IG) plus the configured / throttle
 *  signals. */
export interface TikTokProviderBlock {
  isConfigured: boolean;
  requestsToday: number;
  creditsUsed: number;
  dailyCap: number;
  remainingBalance: number;
  prepaidBalance: number;
  throttleState: SocialThrottleState;
}

export async function getTikTokProviderBlock(now: Date = new Date()): Promise<TikTokProviderBlock> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    PLATFORM,
    PROVIDER,
    now,
  );
  const throttleState = await getSocialThrottleState(PLATFORM, PROVIDER, now);
  return {
    isConfigured: isTikTokConfigured(),
    // One credit per request (D-18) ⇒ requests today == credits used today.
    requestsToday: creditsUsed,
    creditsUsed,
    dailyCap,
    remainingBalance: prepaidBalance,
    prepaidBalance,
    throttleState,
  };
}

/**
 * tiktokObservability — surface composed into tiktokAdapter via the barrel
 * (index.ts). isOperatorConfigured is a GETTER so it is evaluated at READ time via
 * the registry check (TIKTOK_PROVIDER === "scrapecreators" &&
 * SCRAPECREATORS_API_KEY !== ""), matching the CHECKLIST "runtime-evaluated"
 * contract — a plain `isTikTokConfigured()` value would freeze the answer at
 * module load.
 */
export const tiktokObservability: AdapterObservability = {
  auth: {
    kind: "scrape",
    requiresUserSetup: false,
    get isOperatorConfigured(): boolean {
      return isTikTokConfigured();
    },
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // Per-user fair-share cap on the operator's prepaid pool (shared with IG). The
  // 429 enforcement via enforceAdapterUserQuota runs in fetchEventPreviewMetadata.
  userQuotaCap: {
    requestsPerDay: env.LIMIT_SOCIAL_REQUESTS_PER_DAY,
  },
  // The prepaid balance + daily counter live in social_provider_* under row locks
  // (quota.ts reserveSocialCredits FOR UPDATE), so the adapter needs no singleton
  // runtime — multi-replica workers are clean-safe.
  requiresSingletonRuntime: false,
};

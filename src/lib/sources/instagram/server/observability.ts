// Instagram (ScrapeCreators) observability surface.
//
// Implements the per-adapter AdapterObservability the cross-source /admin/quota
// dashboard reads. Mirrors the Reddit/YouTube observability shape, retargeted to
// the prepaid-credit budget engine (quota.ts):
//
//   - auth.kind = "scrape" (no per-user secrets; operator-configured via the
//     ScrapeCreators key + INSTAGRAM_PROVIDER). isOperatorConfigured comes from
//     the Plan 02 registry check (isInstagramConfigured) — the SOC-05
//     not-configured signal.
//   - quota.getDailyStats(date) — projects today's social_provider_spend +
//     prepaid balance into ObservabilityDailyStats (the single "key" is the
//     provider). costEstimateUsd is creditsUsed * $0.002 (ScrapeCreators list
//     price).
//   - quota.getRecentAudit(limit) — last N social.* throttle/budget audit rows
//     (cross-tenant by design — operator-facing, allowlist-gated upstream).
//   - userQuotaCap.requestsPerDay = env.LIMIT_SOCIAL_REQUESTS_PER_DAY (D-19;
//     the per-user 429 enforcement via enforceAdapterUserQuota lands in Plan 06).
//   - getInstagramProviderBlock() — the additive /admin/quota block (counts +
//     spend/cap + remaining balance, D-23) for Plan 06's read.
//
// COST CONSTANT: ScrapeCreators bills $2 per 1000 credits = $0.002/credit
// (08-SPIKE.md: 1 credit per request). costEstimateUsd is informational only.

import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { env } from "$lib/server/config/env.js";
import type {
  AdapterObservability,
  ObservabilityAuditEntry,
  ObservabilityDailyStats,
} from "$lib/sources/adapter.js";
import { isInstagramConfigured } from "./provider/registry.js";
import {
  getSocialSpendToday,
  getSocialProviderSpendToday,
  getSocialThrottleState,
  type SocialThrottleState,
} from "./quota.js";

const PLATFORM = "instagram";
const PROVIDER = "scrapecreators";

/** ScrapeCreators list price: $2 / 1000 credits = $0.002 per credit (1 credit
 *  per request, 08-SPIKE.md). Informational cost estimate only. */
const USD_PER_CREDIT = 0.002;

/**
 * Project today's prepaid-credit spend + balance into the cross-source
 * ObservabilityDailyStats shape. The single "key" is the provider — IG has no
 * per-key fan-out (one operator ScrapeCreators key), so the keys[] array carries
 * exactly one entry mirroring the aggregate.
 *
 * `throttleState` is the adapter's own classification (worst-of the daily-cap
 * 80/95 gate AND the exhausted-balance hard stop) — consumers do NOT recompute.
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
 * Social-provider audit verbs surfaced on /admin/quota's Instagram tab. Today
 * the budget engine (Plan 03) emits social.provider_throttled (80/95 crossing)
 * and social.budget_exhausted (prepaid balance hit 0).
 */
const SOCIAL_AUDIT_ACTIONS = ["social.budget_exhausted", "social.provider_throttled"] as const;

/**
 * Last N social.* audit rows ordered by createdAt DESC. Cross-tenant
 * aggregation by design: /admin/quota is operator-facing (allowlist-gated
 * upstream — see admin-quota-read.ts). The verbs are system-emitted under the
 * operator's resolved user_id (quota.ts markSocialThrottleTransition), so the
 * read is the operator's pool view, not a tenant view.
 */
async function getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]> {
  // The social.* verbs are emitted for EVERY ScrapeCreators platform (IG +
  // TikTok share the same audit actions). The Instagram observability tab must
  // only surface the IG rows, so filter on metadata.platform = 'instagram' (the
  // 10-04 plan's per-platform audit scope). Without this, the IG tab would mix
  // TikTok throttle/exhaustion rows into the IG view. The TikTok twin gets the
  // mirror filter in its own observability file.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota observability is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Mirrors reddit/youtube getRecentAudit.
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

/** The /admin/quota Instagram block (Plan 06, D-23). Surfaces both the
 *  daily-cap view (requestsToday vs dailyCap) AND the funded view
 *  (prepaidBalance) plus the configured / throttle signals — the additive
 *  remaining-balance display the spike confirmed comes free from every
 *  ScrapeCreators response body. */
export interface InstagramProviderBlock {
  isConfigured: boolean;
  requestsToday: number;
  creditsUsed: number;
  /** JOINT spend across every platform on this provider (IG + TikTok + Reddit) — the
   *  number `dailyCap` and `throttleState` actually gate on. `creditsUsed` above is
   *  only THIS platform's share. */
  providerCreditsUsed: number;
  dailyCap: number;
  /** prepaidBalance is the absolute funded remaining (D-16 hard ceiling). */
  remainingBalance: number;
  prepaidBalance: number;
  throttleState: SocialThrottleState;
}

export async function getInstagramProviderBlock(
  now: Date = new Date(),
): Promise<InstagramProviderBlock> {
  const { creditsUsed, dailyCap, prepaidBalance } = await getSocialSpendToday(
    PLATFORM,
    PROVIDER,
    now,
  );
  const { creditsUsed: providerCreditsUsed } = await getSocialProviderSpendToday(PROVIDER, now);
  const throttleState = await getSocialThrottleState(PLATFORM, PROVIDER, now);
  return {
    isConfigured: isInstagramConfigured(),
    // One credit per request (D-18) ⇒ requests today == credits used today.
    requestsToday: creditsUsed,
    creditsUsed,
    providerCreditsUsed,
    dailyCap,
    remainingBalance: prepaidBalance,
    prepaidBalance,
    throttleState,
  };
}

/**
 * instagramObservability — surface composed into instagramAdapter via the
 * barrel (index.ts). isOperatorConfigured is a GETTER so it is evaluated at READ
 * time via the Plan 02 registry check (INSTAGRAM_PROVIDER === "scrapecreators" &&
 * SCRAPECREATORS_API_KEY !== ""), matching the CHECKLIST "runtime-evaluated"
 * contract — a plain `isInstagramConfigured()` value would freeze the answer at
 * module load. Cheap pure env read; recomputing per-read is harmless (env
 * doesn't change mid-process), and the getter keeps it honest.
 */
export const instagramObservability: AdapterObservability = {
  auth: {
    kind: "scrape",
    requiresUserSetup: false,
    get isOperatorConfigured(): boolean {
      return isInstagramConfigured();
    },
  },
  quota: {
    getDailyStats,
    getRecentAudit,
  },
  // Per-user fair-share cap on the operator's prepaid pool (D-19). The 429
  // enforcement via enforceAdapterUserQuota lands in Plan 06; declaring the cap
  // here is the single source of truth both surfaces read.
  userQuotaCap: {
    requestsPerDay: env.LIMIT_SOCIAL_REQUESTS_PER_DAY,
  },
  // The prepaid balance + daily counter live in social_provider_* under row
  // locks (quota.ts reserveSocialCredits FOR UPDATE), so the adapter needs no
  // singleton runtime — multi-replica workers are clean-safe.
  requiresSingletonRuntime: false,
};

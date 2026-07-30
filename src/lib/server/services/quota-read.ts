// Single home for the per-user quota READ (D-03, one source of truth).
//
// Both /sources and /audit render the SAME QuotaStatusBanner; this module
// is the ONE code path that computes what the banner shows, so the two
// surfaces can never drift. Extracted out of sources-page-read.ts — the
// computation used to be private there; lifting it makes the read a
// first-class, independently-consumable service.
//
// Tenant-scope (P0): every function takes `userId` first. The Drizzle
// queries reached from here either filter by `userId` (getUserQuota* read
// audit_log scoped to user_id) or hit operator-level ALLOWLIST surfaces
// (Reddit service-load gauge), so the no-unfiltered-tenant-query rule
// stays satisfied.

import { allAdapters } from "$lib/sources/registry.js";
import { isRedditConfigured } from "$lib/sources/reddit/server/provider/registry.js";
import { getRedditProviderBlock } from "$lib/sources/reddit/server/observability.js";
import { env } from "../config/env.js";
import { getUserQuotaUsedToday, getUserQuotaLifetime, nextPacificMidnight } from "./quota.js";

export interface QuotaPlatformView {
  kind: string;
  today: { requests: number; events: number };
  lifetime: { requests: number; events: number };
  cap: { requestsPerDay?: number; eventsPerDay?: number };
  resetsInMs: number;
}

export type RedditQuotaView =
  | {
      isOperatorConfigured: true;
      // Two INDEPENDENT per-kind daily buckets — mirrors enforcement. The per-user cap
      // (enforceAdapterUserQuota / getUserQuotaUsedToday) keys on the SOURCE KIND, so
      // reddit_account and reddit_subreddit each get their OWN LIMIT_SOCIAL_REQUESTS_PER_
      // DAY allowance. Surfacing them as two rows (not a summed single row) keeps the
      // banner honest: 30 account + 30 subreddit is 30/50 AND 30/50, never 60/50.
      accountRequests: { used: number; cap: number };
      subredditRequests: { used: number; cap: number };
      serviceLoad: { used: number; capacity: number };
    }
  | { isOperatorConfigured: false };

/**
 * Per-adapter quota usage (today + lifetime) for the QuotaStatusBanner.
 * Iterates allAdapters so a new source kind adds a row automatically —
 * no edits needed here.
 */
export async function loadQuotaPlatforms(userId: string): Promise<QuotaPlatformView[]> {
  const resetAt = nextPacificMidnight();
  const resetsInMs = Math.max(0, resetAt.getTime() - Date.now());
  return Promise.all(
    allAdapters.map(async (a) => {
      const today = await getUserQuotaUsedToday(userId, a.kind);
      const lifetime = await getUserQuotaLifetime(userId, a.kind);
      return {
        kind: a.kind,
        today,
        lifetime,
        cap: {
          requestsPerDay: a.observability.userQuotaCap?.requestsPerDay,
          eventsPerDay: a.observability.userQuotaCap?.eventsPerDay,
        },
        resetsInMs,
      };
    }),
  );
}

/**
 * Reddit-specific block. The Reddit tab in QuotaStatusBanner renders a
 * 3-line view (source-actions / post-refreshes / service-load) instead
 * of the YouTube two-axis bars; when the operator hasn't configured
 * Reddit import (isRedditConfigured() false) we surface the "not
 * configured" empty state.
 */
export async function loadRedditQuota(userId: string): Promise<RedditQuotaView> {
  // The rebuilt Reddit adapter (Phase 12) is a PAID ScrapeCreators provider behind
  // the D-08 kill-switch, NOT the old strict-rate-limited free-`.json` path. When the
  // operator hasn't opted in (isRedditConfigured() false — REDDIT_IMPORT_ENABLED unset
  // is the default) the banner renders the not-configured empty state.
  if (!isRedditConfigured()) return { isOperatorConfigured: false };

  // Configured: Reddit shares the ScrapeCreators prepaid pool (with IG/TikTok) and is
  // fair-shared per user via LIMIT_SOCIAL_REQUESTS_PER_DAY — the old two-axis 15-min
  // sliding cap is gone. Enforcement keys the cap per SOURCE KIND (reddit_account and
  // reddit_subreddit are separate keyspaces — Phase 10 two-keyspace lesson), so the two
  // usages are INDEPENDENT and must NOT be summed: surface them as two per-kind rows,
  // each against its own daily allowance, plus the operator's shared ScrapeCreators
  // daily spend as the service-load line.
  const [acctUsage, subUsage, block] = await Promise.all([
    getUserQuotaUsedToday(userId, "reddit_account"),
    getUserQuotaUsedToday(userId, "reddit_subreddit"),
    getRedditProviderBlock(),
  ]);
  const perUserCap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
  return {
    isOperatorConfigured: true,
    accountRequests: { used: acctUsage.requests, cap: perUserCap },
    subredditRequests: { used: subUsage.requests, cap: perUserCap },
    // JOINT provider spend, not Reddit's share: `dailyCap` is the shared
    // ScrapeCreators envelope (IG + TikTok + Reddit), so pairing it with Reddit-only
    // credits told the user "40/1000" at the exact moment their refresh was being
    // refused because the pool stood at 940/1000.
    serviceLoad: { used: block.providerCreditsUsed, capacity: block.dailyCap },
  };
}

/**
 * The public contract both /sources and /audit consume. Composes the two
 * per-aspect reads; whichever surface calls this gets byte-identical data.
 */
export async function loadUserQuota(
  userId: string,
): Promise<{ quotaPlatforms: QuotaPlatformView[]; redditQuota: RedditQuotaView }> {
  const [quotaPlatforms, redditQuota] = await Promise.all([
    loadQuotaPlatforms(userId),
    loadRedditQuota(userId),
  ]);
  return { quotaPlatforms, redditQuota };
}

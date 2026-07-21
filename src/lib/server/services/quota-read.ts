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
// TODO(12-06): re-wire the Reddit quota block against the rebuilt adapter
// (redditAdapter / getRecentLoad / checkRedditUserCap were razed in 12-02).
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
      sourceActions: { used: number; cap: number; windowMinutes: number };
      postRefreshes: { used: number; cap: number; windowMinutes: number };
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
 * REDDIT_USER_AGENT we surface the "not configured" empty state.
 */
export async function loadRedditQuota(_userId: string): Promise<RedditQuotaView> {
  // TODO(12-06): re-wire against the rebuilt ScrapeCreators reddit adapter. The
  // old free-`.json` quota path (checkRedditUserCap / getRecentLoad) was razed in
  // Plan 12-02; until Plans 12-05/12-06 restore the adapter + its user-cap
  // service, the banner renders the "not configured" empty state (the same state
  // the empty-provider degrade will show). REDDIT_IMPORT_ENABLED is off by
  // default, so this is the correct interim signal.
  return { isOperatorConfigured: false };
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

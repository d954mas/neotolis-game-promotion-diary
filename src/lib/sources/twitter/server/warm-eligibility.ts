// Warm-post eligibility for Twitter/X auto-refresh.
//
// Thin config over the shared selector (src/lib/sources/server/social-warm-lane.ts
// createWarmEligibilitySelector). The YOUNG-AND-STALE predicate + the #70 P1-A
// auth_error nuance (NOT excluded — the HTTP seam collapses transient +
// budget-exhaustion into auth_error; bounded churn via poll_failure_count) live in
// the shared factory; this file binds the Twitter table + the TWITTER_WARM_* envs.
//
// The 26h staleness gate (TWITTER_WARM_STALENESS_HOURS) sits just over the 24h free
// account-poll interval so a page-1 tweet is never double-paid (the #70 lesson).
//
// Cross-tenant by design: the scheduler fan-out is service-wide; twitter_posts is
// public-data; the per-post writeSnapshot downstream is public-data. ONE row per
// tweet regardless of how many tenants reference it.

import { twitterPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";
import { createWarmEligibilitySelector } from "$lib/sources/server/social-warm-lane.js";

/**
 * Resolve the distinct tweet_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectWarmTikTokPostIds.
 */
export const selectWarmTwitterPostIds = createWarmEligibilitySelector({
  eventKind: "twitter_post",
  postsTable: twitterPosts,
  idColumn: twitterPosts.tweetId,
  publishedAtColumn: twitterPosts.publishedAt,
  lastPolledAtColumn: twitterPosts.lastPolledAt,
  lastPollStatusColumn: twitterPosts.lastPollStatus,
  pollFailureCountColumn: twitterPosts.pollFailureCount,
  windowDays: () => env.TWITTER_WARM_WINDOW_DAYS,
  stalenessHours: () => env.TWITTER_WARM_STALENESS_HOURS,
  maxFailures: () => env.TWITTER_WARM_MAX_FAILURES,
});

// Warm-post eligibility for TikTok auto-refresh.
//
// Thin config over the shared selector (src/lib/sources/server/social-warm-lane.ts
// createWarmEligibilitySelector). The YOUNG-AND-STALE predicate + the #70 P1-A
// auth_error nuance (NOT excluded — the HTTP seam collapses transient +
// budget-exhaustion into auth_error; bounded churn via poll_failure_count) live in
// the shared factory; this file binds the TikTok table + the TIKTOK_WARM_* envs.
//
// Cross-tenant by design: the scheduler fan-out is service-wide; tiktok_posts is
// public-data; the per-post writeSnapshot downstream is public-data. ONE row per
// post regardless of how many tenants reference it.

import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";
import { createWarmEligibilitySelector } from "$lib/sources/server/social-warm-lane.js";

/**
 * Resolve the distinct aweme_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectWarmInstagramPostIds.
 */
export const selectWarmTikTokPostIds = createWarmEligibilitySelector({
  eventKind: "tiktok_post",
  postsTable: tiktokPosts,
  idColumn: tiktokPosts.awemeId,
  publishedAtColumn: tiktokPosts.publishedAt,
  lastPolledAtColumn: tiktokPosts.lastPolledAt,
  lastPollStatusColumn: tiktokPosts.lastPollStatus,
  pollFailureCountColumn: tiktokPosts.pollFailureCount,
  windowDays: () => env.TIKTOK_WARM_WINDOW_DAYS,
  stalenessHours: () => env.TIKTOK_WARM_STALENESS_HOURS,
  maxFailures: () => env.TIKTOK_WARM_MAX_FAILURES,
});

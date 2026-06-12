// Warm-post eligibility for Instagram auto-refresh (#70).
//
// Thin config over the shared selector (src/lib/sources/server/social-warm-lane.ts
// createWarmEligibilitySelector). The predicate — YOUNG (< INSTAGRAM_WARM_WINDOW_DAYS)
// AND STALE (last_polled_at older than INSTAGRAM_WARM_STALENESS_HOURS), minus
// terminal not_found/private and persistently-failing (>= INSTAGRAM_WARM_MAX_FAILURES)
// posts — and the #70 P1-A auth_error nuance (NOT excluded; IG collapses transient +
// budget-exhaustion into auth_error, so bounded churn via poll_failure_count instead
// of a wholesale freeze) live in the shared factory. This file binds the IG table +
// env knobs.
//
// Cross-tenant by design (mirrors poll-eligibility.ts): the scheduler fan-out is
// service-wide; instagram_posts is public-data; the per-post writeSnapshot
// downstream is public-data. ONE row per post regardless of how many tenants
// reference it (a single single-post fetch serves all — no per-tenant fan-out).

import { instagramPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";
import { createWarmEligibilitySelector } from "$lib/sources/server/social-warm-lane.js";

/**
 * Resolve the distinct post_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectEligibleVideoIds.
 */
export const selectWarmInstagramPostIds = createWarmEligibilitySelector({
  eventKind: "instagram_post",
  postsTable: instagramPosts,
  idColumn: instagramPosts.postId,
  publishedAtColumn: instagramPosts.publishedAt,
  lastPolledAtColumn: instagramPosts.lastPolledAt,
  lastPollStatusColumn: instagramPosts.lastPollStatus,
  pollFailureCountColumn: instagramPosts.pollFailureCount,
  windowDays: () => env.INSTAGRAM_WARM_WINDOW_DAYS,
  stalenessHours: () => env.INSTAGRAM_WARM_STALENESS_HOURS,
  maxFailures: () => env.INSTAGRAM_WARM_MAX_FAILURES,
});

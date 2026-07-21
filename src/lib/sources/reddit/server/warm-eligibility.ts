// Warm-post eligibility for Reddit auto-refresh.
//
// Thin config over the shared selector (src/lib/sources/server/social-warm-lane.ts
// createWarmEligibilitySelector). The YOUNG-AND-STALE predicate + the auth_error
// nuance live in the shared factory; this file binds the reddit_posts table + the
// REDDIT_WARM_* envs + the ★deletion-detect exclusion.
//
// Reddit posts stabilize in 1–2 days (unlike YouTube's long tail), so
// REDDIT_WARM_WINDOW_DAYS defaults to 2 (12-02) — the short window already gives the
// spike's "daily-walk + one-shot next-day catch" behavior without a long-lived warm
// lane. REDDIT_WARM_STALENESS_HOURS (26h) sits just over the 24h free walk interval
// so a page-1 post is never double-paid (the #70 lesson).
//
// ★ DELETION-DETECT EXCLUSION: posts with reddit_posts.deletion_detected_at set are
// removed from warm eligibility — once a post is detected removed, re-polling it
// only burns credit on a dead post (and Plan 05's purge cron will null its author).
//
// Cross-tenant by design: the scheduler fan-out is service-wide; reddit_posts is
// public-data; the per-post writeSnapshot downstream is public-data. ONE row per
// post regardless of how many tenants reference it.

import { isNull } from "drizzle-orm";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";
import { createWarmEligibilitySelector } from "$lib/sources/server/social-warm-lane.js";

/**
 * Resolve the distinct post_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectWarmTwitterPostIds.
 */
export const selectWarmRedditPostIds = createWarmEligibilitySelector({
  eventKind: "reddit_post",
  postsTable: redditPosts,
  idColumn: redditPosts.postId,
  publishedAtColumn: redditPosts.publishedAt,
  lastPolledAtColumn: redditPosts.lastPolledAt,
  lastPollStatusColumn: redditPosts.lastPollStatus,
  pollFailureCountColumn: redditPosts.pollFailureCount,
  windowDays: () => env.REDDIT_WARM_WINDOW_DAYS,
  stalenessHours: () => env.REDDIT_WARM_STALENESS_HOURS,
  maxFailures: () => env.REDDIT_WARM_MAX_FAILURES,
  // Stop warm-refreshing a post once it is detected removed (Variant A / the belt).
  extraWhere: isNull(redditPosts.deletionDetectedAt),
});

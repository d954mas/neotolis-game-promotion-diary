// reddit.poll.cron tier=warm — per-post auto-refresh producer.
//
// Fires hourly ({tier:"warm"}). Selects warm reddit posts (warm-eligibility, window=2
// days per the 12-SPIKE "no long-lived warm lane" decision — a post gets at most ONE
// next-day catch if it fell off the daily walk) and enqueues ONE dedup'd service_post
// row per post; the Reddit lane worker owns the upstream fetch + writeSnapshot +
// cron-pool accounting.
//
// Thin config over the shared handler (social-warm-lane.ts createWarmRefreshHandler):
// the provider-unconfigured skip-gate + the throttle skip-gate (warm is NON-ESSENTIAL
// background spend; skip at >= "eighty") live in the factory. getSocialProvider /
// getSocialThrottleState are threaded from the Reddit tree so the per-tree vi.mock
// seam keeps working.

import { getSocialThrottleState } from "../quota.js";
import { getSocialProvider } from "../provider/registry.js";
import { selectWarmRedditPostIds } from "../warm-eligibility.js";
import { enqueueServiceRedditPostStats } from "./enqueue-service-post-stats.js";
import { createWarmRefreshHandler } from "$lib/sources/server/social-warm-lane.js";

export const handleRedditWarmRefresh = createWarmRefreshHandler({
  platform: "reddit",
  provider: "scrapecreators",
  getSocialProvider,
  getSocialThrottleState,
  selectWarmPostIds: selectWarmRedditPostIds,
  enqueueServiceStats: enqueueServiceRedditPostStats,
});

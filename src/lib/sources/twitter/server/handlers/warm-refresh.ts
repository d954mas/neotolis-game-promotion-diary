// twitter.poll.cron tier=warm — per-post auto-refresh producer.
//
// Fires hourly ({tier:"warm"}). Selects warm tweets (warm-eligibility) and enqueues
// ONE dedup'd service_post row per tweet; the Twitter lane worker owns the upstream
// fetch + writeSnapshot + cron-pool accounting.
//
// Thin config over the shared handler (src/lib/sources/server/social-warm-lane.ts
// createWarmRefreshHandler): the provider-unconfigured skip-gate and the throttle
// skip-gate (warm is NON-ESSENTIAL background spend; skip at >= "eighty") live in
// the factory. getSocialProvider / getSocialThrottleState are threaded from the
// Twitter tree so the per-tree vi.mock seam keeps working.

import { getSocialThrottleState } from "../quota.js";
import { getSocialProvider } from "../provider/registry.js";
import { selectWarmTwitterPostIds } from "../warm-eligibility.js";
import { enqueueServiceTwitterPostStats } from "./enqueue-service-post-stats.js";
import { createWarmRefreshHandler } from "$lib/sources/server/social-warm-lane.js";

export const handleTwitterWarmRefresh = createWarmRefreshHandler({
  platform: "twitter",
  provider: "twitterapi.io",
  getSocialProvider,
  getSocialThrottleState,
  selectWarmPostIds: selectWarmTwitterPostIds,
  enqueueServiceStats: enqueueServiceTwitterPostStats,
});

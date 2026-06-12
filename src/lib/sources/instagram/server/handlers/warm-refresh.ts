// instagram.poll.cron tier=warm — per-post auto-refresh producer (#70).
//
// Fires hourly ({tier:"warm"}). Selects warm posts (warm-eligibility) and enqueues
// ONE dedup'd service_post row per post; the IG lane worker owns the upstream fetch
// + writeSnapshot + cron-pool accounting. Mirrors youtube poll-active →
// selectEligibleVideoIds → enqueueServiceVideoStats.
//
// Thin config over the shared handler (src/lib/sources/server/social-warm-lane.ts
// createWarmRefreshHandler): the provider-unconfigured skip-gate (#70 ultrareview
// P1 — an enqueued row would orphan as pending forever) and the throttle skip-gate
// (warm is NON-ESSENTIAL background spend; skip at >= "eighty") live in the factory.
// getSocialProvider / getSocialThrottleState are threaded from the IG tree so the
// per-tree vi.mock seam keeps working.

import { getSocialThrottleState } from "../quota.js";
import { getSocialProvider } from "../provider/registry.js";
import { selectWarmInstagramPostIds } from "../warm-eligibility.js";
import { enqueueServiceInstagramPostStats } from "./enqueue-service-post-stats.js";
import { createWarmRefreshHandler } from "$lib/sources/server/social-warm-lane.js";

export const handleInstagramWarmRefresh = createWarmRefreshHandler({
  platform: "instagram",
  provider: "scrapecreators",
  getSocialProvider,
  getSocialThrottleState,
  selectWarmPostIds: selectWarmInstagramPostIds,
  enqueueServiceStats: enqueueServiceInstagramPostStats,
});

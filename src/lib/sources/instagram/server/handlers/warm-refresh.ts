// instagram.poll.cron tier=warm — per-post auto-refresh producer (#70).
//
// Fires hourly ({tier:"warm"}). Selects warm posts (warm-eligibility) and enqueues
// ONE dedup'd service_post row per post; the IG lane worker owns the upstream
// fetch + writeSnapshot + cron-pool accounting. Mirrors youtube poll-active →
// selectEligibleVideoIds → enqueueServiceVideoStats.
//
// Thin by design: a DIFFERENT operation from the active/cold account-level page-1
// walk, so handleInstagramPollCron branches here BEFORE its account-picker runs.
//
// Throttle skip-gate: warm is NON-ESSENTIAL background spend (like the cold tier)
// — skip at >= "eighty". The hourly cadence + 22h staleness gate + skip-if-pending
// dedup mean a post gets at most ~1 paid refresh/day.

import { logger } from "$lib/server/logger.js";
import { getSocialThrottleState } from "../quota.js";
import { selectWarmInstagramPostIds } from "../warm-eligibility.js";
import { enqueueServiceInstagramPostStats } from "./enqueue-service-post-stats.js";

const PLATFORM = "instagram";
const PROVIDER = "scrapecreators";

export async function handleInstagramWarmRefresh(job: { id?: string }): Promise<void> {
  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive" || throttle === "eighty") {
    logger.info(
      { jobId: job.id, throttle },
      "instagram.poll.cron tier=warm: budget throttled — skipping non-essential warm refresh",
    );
    return;
  }

  const postIds = await selectWarmInstagramPostIds(new Date());
  if (postIds.length === 0) {
    logger.debug({ jobId: job.id }, "instagram.poll.cron tier=warm: no warm posts due");
    return;
  }

  const enqueued = await enqueueServiceInstagramPostStats(postIds);
  logger.info(
    { jobId: job.id, selected: postIds.length, enqueued },
    "instagram.poll.cron tier=warm: service_post rows enqueued",
  );
}

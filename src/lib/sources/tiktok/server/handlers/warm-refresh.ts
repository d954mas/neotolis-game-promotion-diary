// tiktok.poll.cron tier=warm — per-post auto-refresh producer (clone of
// instagram/server/handlers/warm-refresh.ts).
//
// Fires hourly ({tier:"warm"}). Selects warm posts (warm-eligibility) and enqueues
// ONE dedup'd service_post row per post; the TikTok lane worker owns the upstream
// fetch + writeSnapshot + cron-pool accounting.
//
// Thin by design: a DIFFERENT operation from the active/cold account-level page-1
// walk, so handleTikTokPollCron branches here BEFORE its account-picker runs.
//
// Throttle skip-gate: warm is NON-ESSENTIAL background spend (like the cold tier)
// — skip at >= "eighty". The hourly cadence + the staleness gate + skip-if-pending
// dedup mean a post gets at most ~1 paid refresh/day.

import { logger } from "$lib/server/logger.js";
import { getSocialThrottleState } from "../quota.js";
import { getSocialProvider } from "../provider/registry.js";
import { selectWarmTikTokPostIds } from "../warm-eligibility.js";
import { enqueueServiceTikTokPostStats } from "./enqueue-service-post-stats.js";

const PLATFORM = "tiktok";
const PROVIDER = "scrapecreators";

export async function handleTikTokWarmRefresh(job: { id?: string }): Promise<void> {
  // Don't enqueue work the lane can't run: the refresh lane worker is disabled
  // (isEnabled) when the provider is unconfigured, so service_post rows would
  // orphan as pending forever. Mirror the manual canRun gate.
  if (getSocialProvider("tiktok") === null) {
    logger.debug(
      { jobId: job.id },
      "tiktok.poll.cron tier=warm: provider unconfigured — skip (lane disabled)",
    );
    return;
  }

  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive" || throttle === "eighty") {
    logger.info(
      { jobId: job.id, throttle },
      "tiktok.poll.cron tier=warm: budget throttled — skipping non-essential warm refresh",
    );
    return;
  }

  const awemeIds = await selectWarmTikTokPostIds(new Date());
  if (awemeIds.length === 0) {
    logger.debug({ jobId: job.id }, "tiktok.poll.cron tier=warm: no warm posts due");
    return;
  }

  const enqueued = await enqueueServiceTikTokPostStats(awemeIds);
  logger.info(
    { jobId: job.id, selected: awemeIds.length, enqueued },
    "tiktok.poll.cron tier=warm: service_post rows enqueued",
  );
}

// Active-tier poll producer.
//
// The youtube.poll.cron schedule fires with `{ tier: "active" }`. This
// handler only resolves eligible video ids and enqueues them into
// adapter_refresh_queue:youtube_channel:service_video. The SQL video worker owns upstream
// videos.list, batching, retries, writeSnapshot, and quota accounting.

import { TIER_BOUNDARY_ACTIVE_MS } from "$lib/server/services/tier-resolver.js";
import { selectEligibleVideoIds } from "$lib/server/services/poll-eligibility.js";
import { getThrottleState, markThrottleTransition, THROTTLE_EIGHTY_THRESHOLD } from "../quota.js";
import { logger } from "$lib/server/logger.js";
import { enqueueServiceVideoStats } from "./enqueue-service-video-stats.js";

export async function handlePollActive(job: {
  id?: string;
  data: { tier: "active" } & Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const throttle = await getThrottleState(now);
  if (throttle === "ninetyfive") {
    logger.info(
      { jobId: job.id, throttle, tier: "active" },
      "youtube.poll.cron tier=active: skip - quota at 95%",
    );
    return;
  }
  if (throttle === "eighty") {
    try {
      await markThrottleTransition({
        state: "eighty",
        estimatedUnits: THROTTLE_EIGHTY_THRESHOLD,
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err }, "poll-active: markThrottleTransition failed");
    }
  }

  const cutoffOldest = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const videoIds = await selectEligibleVideoIds(null, cutoffOldest, "active", now);
  if (videoIds.length === 0) {
    logger.debug(
      { jobId: job.id, tier: "active", count: 0 },
      "youtube.poll.cron tier=active: no eligible videos",
    );
    return;
  }

  const enqueued = await enqueueServiceVideoStats(videoIds, "active");
  logger.info(
    { jobId: job.id, tier: "active", selected: videoIds.length, enqueued },
    "youtube.poll.cron tier=active: service_video rows enqueued",
  );
}

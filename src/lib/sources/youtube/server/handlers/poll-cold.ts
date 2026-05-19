// Cold-tier poll producer.
//
// The youtube.poll.cron schedule fires with `{ tier: "cold" }`. This
// handler only resolves eligible video ids and enqueues them into
// adapter_refresh_queue:youtube_channel:service_video. The SQL video worker owns upstream
// videos.list, batching, retries, writeSnapshot, and quota accounting.

import {
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "$lib/server/services/tier-resolver.js";
import { selectEligibleVideoIds } from "$lib/server/services/poll-eligibility.js";
import { getThrottleState } from "../quota.js";
import { logger } from "$lib/server/logger.js";
import { enqueueServiceVideoStats } from "./enqueue-service-video-stats.js";

export async function handlePollCold(job: {
  id?: string;
  data: { tier: "cold" } & Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const throttle = await getThrottleState(now);
  if (throttle !== "ok") {
    logger.info(
      { jobId: job.id, throttle, tier: "cold" },
      "youtube.poll.cron tier=cold: skip - quota throttled",
    );
    return;
  }

  const cutoffNewest = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const cutoffOldest = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
  const videoIds = await selectEligibleVideoIds(cutoffNewest, cutoffOldest, "cold", now);
  if (videoIds.length === 0) {
    logger.debug(
      { jobId: job.id, tier: "cold", count: 0 },
      "youtube.poll.cron tier=cold: no eligible videos",
    );
    return;
  }

  const enqueued = await enqueueServiceVideoStats(videoIds, "cold");
  logger.info(
    { jobId: job.id, tier: "cold", selected: videoIds.length, enqueued },
    "youtube.poll.cron tier=cold: service_video rows enqueued",
  );
}

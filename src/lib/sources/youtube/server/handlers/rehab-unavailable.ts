// Weekly rehab-unavailable producer.
//
// Recovers videos that went private/inaccessible and later came back public
// without requiring user manual refresh. This handler only selects bounded
// candidates and enqueues them into the shared service_video lane; the lane
// worker owns videos.list batching, quota accounting, retries, and snapshots.

import { sql, and, lt } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideos } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { enqueueServiceVideoStats } from "./enqueue-service-video-stats.js";

const REHAB_BATCH_LIMIT = 50;

export async function handleRehabUnavailable(job: { id: string }): Promise<void> {
  // PUBLIC-DATA TABLE: youtube_videos is tenant-agnostic external cache data.
  const candidates = await db
    .select({
      videoId: youtubeVideos.videoId,
    })
    .from(youtubeVideos)
    .where(
      and(
        sql`${youtubeVideos.lastPollStatus} IN ('not_found', 'private')`,
        lt(youtubeVideos.pollFailureCount, 5),
      ),
    )
    .orderBy(sql`${youtubeVideos.lastPolledAt} DESC NULLS LAST`)
    .limit(REHAB_BATCH_LIMIT);

  if (candidates.length === 0) {
    logger.debug({ jobId: job.id }, "rehab-unavailable: no candidates");
    return;
  }

  const videoIds = candidates.map((c) => c.videoId);
  const enqueued = await enqueueServiceVideoStats(videoIds, "rehab");
  logger.info(
    { jobId: job.id, candidates: videoIds.length, enqueued },
    "rehab-unavailable: service_video rows enqueued",
  );
}

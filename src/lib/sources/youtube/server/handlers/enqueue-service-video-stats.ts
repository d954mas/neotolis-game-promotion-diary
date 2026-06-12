// YouTube service_video stats producer — enqueues service_video rows into
// adapter_refresh_queue. Thin wrapper over the shared producer
// (src/lib/sources/server/social-warm-lane.ts createServiceStatsEnqueuer): advisory-lock
// per id (serialize concurrent producers) + skip-if-pending dedup. user_id=NULL →
// public-data cron lane.
//
// The producer ALGORITHM is identical to the social warm lanes' (same sorted-lock +
// pending/processing dedup scan + row shape), so it shares the same factory. The
// two YouTube-only differences are pure parameters: the payload id key is
// `video_id` (not `post_id`), and the payload carries a `flow` discriminator that
// varies per call site (active/cold/backfill/no_data/rehab) — supplied per call as
// the extra payload.

import { createServiceStatsEnqueuer } from "$lib/sources/server/social-warm-lane.js";

export type YoutubeServiceVideoFlow = "active" | "cold" | "backfill" | "no_data" | "rehab";

const enqueue = createServiceStatsEnqueuer<{ flow: YoutubeServiceVideoFlow }>({
  adapterKind: "youtube_channel",
  queueName: "service_video",
  lockPrefix: "youtube_service_video:",
  rowType: "video_stats",
  payloadIdKey: "video_id",
});

export async function enqueueServiceVideoStats(
  videoIds: string[],
  flow: YoutubeServiceVideoFlow,
): Promise<number> {
  return enqueue(videoIds, { flow });
}

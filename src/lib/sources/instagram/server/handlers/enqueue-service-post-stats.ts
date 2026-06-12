// Warm auto-refresh producer — enqueues service_post rows into
// adapter_refresh_queue (#70). Thin config over the shared producer
// (src/lib/sources/server/social-warm-lane.ts createServiceStatsEnqueuer): advisory-lock
// per id (serialize concurrent producers) + skip-if-pending dedup (the auto path
// MUST dedup — between enqueue and processing last_polled_at is still stale, so the
// next warm tick would re-select the same post; the manual user_post path stays
// cooldown-only). user_id=NULL → public-data cron lane.

import { createServiceStatsEnqueuer } from "$lib/sources/server/social-warm-lane.js";

export const enqueueServiceInstagramPostStats = createServiceStatsEnqueuer({
  adapterKind: "instagram_account",
  queueName: "service_post",
  lockPrefix: "instagram_service_post:",
  rowType: "post_stats",
  payloadIdKey: "post_id",
});

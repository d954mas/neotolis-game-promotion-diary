// Telegram warm auto-refresh producer — enqueues service_post rows into
// adapter_refresh_queue. Thin config over the shared producer
// (src/lib/sources/server/social-warm-lane.ts createServiceStatsEnqueuer): advisory-lock
// per id (serialize concurrent producers) + skip-if-pending dedup (the auto path
// MUST dedup — between enqueue and processing last_polled_at is still stale, so the
// next warm tick would re-select the same post; the manual user_post path stays
// cooldown-only). user_id=NULL → public-data cron lane.
//
// NO throttle/budget reserve here (Telegram is free) — the producer just enqueues
// the dedup'd row; the lane worker drains it through the pacer. The producer
// ALGORITHM is identical to the paid scrapers' (same row shape, same sorted-lock +
// pending/processing dedup scan), so it shares the same factory; the "no budget
// gate" difference lives in the warm-refresh HANDLER, not here.

import { createServiceStatsEnqueuer } from "$lib/sources/server/social-warm-lane.js";

export const enqueueServiceTelegramPostStats = createServiceStatsEnqueuer({
  adapterKind: "telegram_channel",
  queueName: "service_post",
  lockPrefix: "telegram_service_post:",
  rowType: "post_stats",
  payloadIdKey: "post_id",
});

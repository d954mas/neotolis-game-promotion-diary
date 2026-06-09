// telegram.poll.cron tier=warm — per-post auto-refresh producer (mirrors
// instagram/handlers/warm-refresh.ts, gates STRIPPED — Telegram is free).
//
// Fires hourly ({tier:"warm"}). Selects warm posts (warm-eligibility) and
// enqueues ONE dedup'd service_post row per post; the Telegram lane worker owns
// the upstream ?embed=1 fetch + writeTelegramSnapshot.
//
// Thin by design: a DIFFERENT operation from the active/cold listing-poll walk,
// so the poll-cron handler branches HERE before its listing-channel picker runs.
//
// STRIP-LIST vs IG: NO getSocialProvider===null gate (Telegram has no provider —
// it is always available), NO getSocialThrottleState defer gate (Telegram is
// free — there is no budget to throttle on). The producer enqueues regardless of
// any budget because there is none. The hourly cadence + the 12h staleness gate
// + skip-if-pending dedup self-pace a post to ~1 refresh/12h.

import { logger } from "$lib/server/logger.js";
import { selectWarmTelegramPostIds } from "../warm-eligibility.js";
import { enqueueServiceTelegramPostStats } from "./enqueue-service-warm.js";

export async function handleTelegramWarmRefresh(job: { id?: string }): Promise<void> {
  const postIds = await selectWarmTelegramPostIds(new Date());
  if (postIds.length === 0) {
    logger.debug({ jobId: job.id }, "telegram.poll.cron tier=warm: no warm posts due");
    return;
  }

  const enqueued = await enqueueServiceTelegramPostStats(postIds);
  logger.info(
    { jobId: job.id, selected: postIds.length, enqueued },
    "telegram.poll.cron tier=warm: service_post rows enqueued",
  );
}

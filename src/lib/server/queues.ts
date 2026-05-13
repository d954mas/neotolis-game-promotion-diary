// pg-boss queue registry — single source of truth for queue names.
//
// pg-boss v10+ requires every queue to be created via `boss.createQueue()`
// before any `send()` or `work()` call. Forgetting to declare a queue causes
// silent loss-on-send. We mitigate by:
//   1. Centralizing every queue name in `QUEUES` (this module is the only
//      place the strings appear).
//   2. Exposing `declareAllQueues(boss)` so worker boot calls one function
//      and gets every queue declared idempotently.
//
// Per-kind queue topology. Cross-source queues (purge.daily,
// internal.healthcheck) remain kind-agnostic. New sources add their own
// per-kind queues here without touching cross-source ones.
//
// youtube.poll.cron carries TWO schedules via pg-boss v11+ key-based
// multiple-schedule-per-queue:
//   - key: "active" — every 6 hours (Active tier, age < 24h)
//   - key: "cold"   — daily 5am Pacific (Cold tier, 24h <= age < 28d)
// The poll-cron handler dispatches on job.data.tier.
//
// We don't import pg-boss types directly here. The `MinimalBoss` interface
// keeps this module decoupled from pg-boss's full type surface — useful for
// testability and for future major-version churn.

export const QUEUES = {
  // Cross-source / non-per-kind:
  PURGE_DAILY: "purge.daily",
  INTERNAL_HEALTHCHECK: "internal.healthcheck",

  // Per-kind: youtube
  YOUTUBE_POLL_CRON: "youtube.poll.cron",
  YOUTUBE_POLL_USER: "youtube.poll.user",
  /** Channel-scoped backfill. Job payload carries (kind, channelKey,
   *  triggerUserId?, depthBoundIso, flow). One walk per call; fan-out
   *  INSERT to all active subscribers. Singleton key by channelKey
   *  dedupes parallel triggers. */
  YOUTUBE_BACKFILL_CHANNEL: "youtube.backfill.channel",
  YOUTUBE_QUOTA_RESET: "youtube.quota_reset",
  YOUTUBE_REHAB: "youtube.rehab",
  YOUTUBE_CHANNEL_CONTEXT_BACKFILL: "youtube.channel_context_backfill",
  // Daily passive backfill cron. Picker selects channels WHERE
  // backfill_complete=false and enqueues channel-scoped backfill jobs
  // with flow='auto_passive'. Skip-gates at pctOfDaily ≥ 50% (cron pool
  // priority floor — active stats poll protected up to 95%, cold poll
  // to 80%, auto-backfill yields first under contention).
  YOUTUBE_AUTO_BACKFILL_CRON: "youtube.auto_backfill_cron",
  /** Daily INCREMENTAL cron for completed channels. Auto-backfill cron
   *  excludes complete channels (their deep history is done); but the
   *  channel keeps uploading new videos after completion. This cron
   *  picks complete channels with active auto_import subscribers and
   *  triggers a page-1-only walk (cheap: 1 unit/channel/day) to discover
   *  new uploads. Job lands as flow='auto_passive' on
   *  YOUTUBE_BACKFILL_CHANNEL with depthBoundIso=now-N-days bound.
   *  Without this, completed channels go silent until manual
   *  refresh-click. */
  YOUTUBE_INCREMENTAL_CRON: "youtube.incremental_cron",
} as const satisfies Record<string, string>;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

interface MinimalBoss {
  createQueue(name: string): Promise<unknown>;
}

export async function declareAllQueues(boss: MinimalBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    // pg-boss v10+ createQueue is idempotent — safe to call on every boot.
    await boss.createQueue(name);
  }
}

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
  /** Daily DELETE of terminal-state rows from `adapter_refresh_queue`. The
   *  cap counter (services/quota.ts) reads only the 15-min rolling window,
   *  so `status IN ('done','dead_letter')` rows older than 14 days are
   *  dead weight. Without the janitor the table grows unbounded
   *  (~525k rows/year at 8 req/min baseline). 14 days keeps a forensic
   *  window for "my refresh failed last week" investigation, well past
   *  the cap horizon. Authoritative SQL lives in
   *  services/adapter-refresh-queue-janitor.ts. */
  ADAPTER_REFRESH_QUEUE_JANITOR: "adapter-refresh-queue.janitor",

  // Per-kind: youtube
  YOUTUBE_POLL_CRON: "youtube.poll.cron",
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

  // Per-kind: reddit (Phase 03.1 DV-RDT-7). FOUR cron-only pg-boss
  // queues — handlers ENQUEUE rows into adapter_refresh_queue (ZERO
  // Reddit HTTP per D-RDT-CRON-BURST) and return; the 8-tick worker
  // setInterval (src/worker/index.ts) drains the reddit_account lanes at
  // the 8 req/min effective ceiling.
  //
  // The Reddit batch worker does NOT subscribe via pg-boss.work — the
  // SQL FOR UPDATE SKIP LOCKED tick pattern is the load-bearing answer
  // to Reddit's 10 req/min hard limit under multi-replica deploys
  // (D-RDT-WORKER).
  REDDIT_CRON_ENQUEUE_SERVICE_SOURCES: "reddit.cron.enqueue-service-sources",
  REDDIT_CRON_ENQUEUE_SERVICE_POSTS: "reddit.cron.enqueue-service-posts",
  REDDIT_CRON_BASELINES: "reddit.cron.baselines",
  REDDIT_CRON_DELETION_PROPAGATION: "reddit.cron.deletion-propagation",

  // Per-kind: instagram (Phase 8). Mirrors the YouTube cron topology.
  /** Account-scoped resumable walker — one page (12 posts) per tick, fans
   *  out INSERT events to all active subscribers, persists the provider
   *  cursor (next_max_id / paging_info.max_id) to
   *  data_source_channel_state.metadata.lastBackfillCursor. Singleton key by
   *  IG account id dedupes parallel triggers. */
  INSTAGRAM_BACKFILL_ACCOUNT: "instagram.backfill.account",
  /** Active + cold ongoing poll collapsed via pg-boss key-based schedules
   *  ({ tier } payload — active 6h / cold daily). The poll-cron handler
   *  dispatches on job.data.tier. */
  INSTAGRAM_POLL_CRON: "instagram.poll.cron",
  /** Midnight-Pacific daily-cap counter reset. Clears ONLY the daily-cap
   *  spend counter / audit-transition Set — NEVER the prepaid balance, which
   *  is a monotonic hard ceiling (D-16 / Pitfall 3). */
  INSTAGRAM_QUOTA_RESET: "instagram.quota_reset",

  // Per-kind: tiktok (Phase 10, paid ScrapeCreators scraper). Mirrors the
  // Instagram cron topology — TikTok is the same PAID-scraper substrate (one
  // resumable account walker, age-tiered ongoing poll, midnight-PT daily-cap
  // reset), just SINGLE-FEED (one max_cursor / has_more, no posts/reels split).
  /** Account-scoped resumable walker — one page per tick, fans out INSERT events
   *  to all active subscribers, persists the provider cursor (the coerced
   *  max_cursor string) to data_source_channel_state.metadata.tiktok. Singleton
   *  key by TikTok account id dedupes parallel triggers. */
  TIKTOK_BACKFILL_ACCOUNT: "tiktok.backfill.account",
  /** Active + cold ongoing poll + warm per-post producer collapsed via pg-boss
   *  key-based schedules ({ tier } payload — active 6h / cold daily / warm
   *  hourly). The poll-cron handler dispatches on job.data.tier. */
  TIKTOK_POLL_CRON: "tiktok.poll.cron",
  /** Midnight-Pacific daily-cap counter reset. Clears ONLY the daily-cap spend
   *  counter / audit-transition Set — NEVER the prepaid balance, which is a
   *  monotonic hard ceiling shared with IG (D-16 / D-01 / Pitfall 3). */
  TIKTOK_QUOTA_RESET: "tiktok.quota_reset",

  // Per-kind: telegram (Phase 9, free t.me/s scrape — no secret).
  /** Telegram 6h listing poll + warm producer collapsed via pg-boss
   *  key-based schedules ({ tier } payload — active/cold 6h listing /
   *  warm per-post). The poll-cron handler dispatches on job.data.tier.
   *  Cron handlers do ZERO t.me HTTP — they enqueue adapter_refresh_queue
   *  rows; the lane worker fetches (Reddit DV-RDT-7 model). Telegram needs
   *  NO quota_reset queue (free, no daily cap) and NO separate backfill
   *  queue (the backfill walker drains via adapter_refresh_queue lane rows,
   *  not pg-boss). ONE pg-boss cron queue only. */
  TELEGRAM_POLL_CRON: "telegram.poll.cron",
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

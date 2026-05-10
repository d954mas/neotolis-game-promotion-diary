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
// Phase 03.0.1 Plan 07 — Per-kind queue topology (D-10..D-12). Kind-
// agnostic queue names (poll.active, poll.cold, poll.user) collapse into
// per-kind names. Cross-source queues (purge.daily, internal.healthcheck)
// remain kind-agnostic. New sources (Reddit, Twitter, ...) add their own
// per-kind queues here without touching cross-source ones.
//
// youtube.poll.cron carries TWO schedules via pg-boss v11+ key-based
// multiple-schedule-per-queue (RESEARCH.md OQ#2):
//   - key: "active" — every 6 hours (Active tier, age < 24h)
//   - key: "cold"   — daily 5am Pacific (Cold tier, 24h <= age < 28d)
// The poll-cron handler dispatches on job.data.tier.
//
// The two scheduler.tick.* queues (Pattern A from Phase 03.0 Plan 09) are
// RETIRED — collapsed into the youtube.poll.cron schedule directly. The
// scheduler-tick → enqueue.ts → per-event jobs hop is gone; the tier-
// tagged job feeds the per-tier handler directly. Migration 0021 cleans
// up the orphan pgboss.queue / pgboss.schedule / pgboss.job rows.
//
// Queue rename map (Phase 03.0 → Phase 03.0.1 Plan 07):
//   poll.active                      → youtube.poll.cron (key=active)
//   poll.cold                        → youtube.poll.cron (key=cold)
//   poll.user                        → youtube.poll.user
//   scheduler.tick.active            → (RETIRED — cron drives youtube.poll.cron)
//   scheduler.tick.cold              → (RETIRED — cron drives youtube.poll.cron)
//   youtube.rehab_unavailable        → youtube.rehab (D-11 brevity)
//   youtube.quota_reset              → youtube.quota_reset (UNCHANGED)
//   youtube.channel_context_backfill → youtube.channel_context_backfill (UNCHANGED)
//   purge.daily                      → purge.daily (UNCHANGED — cross-source)
//   internal.healthcheck             → internal.healthcheck (UNCHANGED)
//
// New in Plan 07: youtube.backfill.user — Plan 10 user-initiated "Pull new
// content" backfill per source. Declared here (forward-compat scaffold) so
// the worker subscribes to it idempotently; the Plan 10 handler lands the
// actual subscription wire-up.
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
  /** Phase 03.0.1 Wave 2 — channel-scoped backfill. Replaces
   *  YOUTUBE_BACKFILL_USER. Job payload carries (kind, channelKey,
   *  triggerUserId?, depthBoundIso, flow). One walk per call;
   *  fan-out INSERT to all active subscribers. Singleton key by
   *  channelKey dedupes parallel triggers. */
  YOUTUBE_BACKFILL_CHANNEL: "youtube.backfill.channel",
  YOUTUBE_QUOTA_RESET: "youtube.quota_reset",
  YOUTUBE_REHAB: "youtube.rehab",
  YOUTUBE_CHANNEL_CONTEXT_BACKFILL: "youtube.channel_context_backfill",
  // Phase 03.0.1 — daily passive backfill cron. Picker selects sources WHERE
  // backfill_complete=false и enqueue's youtube.backfill.user with
  // metadata.flow='auto_passive'. Skip-gates на pctOfDaily ≥ 50% (cron pool
  // priority floor — active stats poll защищён до 95%, cold poll до 80%,
  // auto-backfill сдаётся first при contention).
  YOUTUBE_AUTO_BACKFILL_CRON: "youtube.auto_backfill_cron",
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

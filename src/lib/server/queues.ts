// pg-boss queue registry — single source of truth for queue names.
//
// RESEARCH.md "Phase-1-specific pitfall: pg-boss queue declaration drift" —
// pg-boss v10+ requires every queue to be created via `boss.createQueue()`
// before any `send()` or `work()` call. Forgetting to declare a queue causes
// silent loss-on-send. We mitigate by:
//   1. Centralizing every queue name in `QUEUES` (this module is the only
//      place the strings appear).
//   2. Exposing `declareAllQueues(boss)` so worker boot calls one function
//      and gets every Phase 1+ queue declared idempotently.
//
// Open Question Q1 (MEDIUM confidence) recommended declaring all four poll
// queues plus `internal.healthcheck` from Phase 1 even though Phase 1 runs
// no jobs — that locks the topology so Phase 3's workers can land without
// re-discussing queue boundaries.
//
// Phase 3.0 Plan 01 — DV-2 collapse. The 4-tier polling model (Hot / Warm /
// Cold / Stale) is replaced with a 3-tier model (Active / Cold / Frozen)
// driven by `last_poll_status` overrides. Concretely:
//   - POLL_HOT  → renamed to POLL_ACTIVE (active = recent activity tier)
//   - POLL_WARM → DROPPED (collapsed into Active)
//   - POLL_COLD → carries forward unchanged
//
// Three new queues land alongside:
//   - PURGE_DAILY                          — Plan 03.0-05 hard-delete worker
//                                             for users whose deleted_at is
//                                             older than RETENTION_DAYS.
//   - YOUTUBE_QUOTA_RESET                  — Plan 03.0-09 daily 00:01 PT cron
//                                             that seeds the next-day row in
//                                             youtube_service_quota_usage and
//                                             trims rows older than ~7 days.
//   - YOUTUBE_CHANNEL_CONTEXT_BACKFILL     — Plan 03.0-10 worker that resolves
//                                             a channel's uploads_playlist_id
//                                             (one channels.list call) on
//                                             first paste of a video from
//                                             that channel.
//
// pgboss persists queue declarations in pgboss.queue across restarts.
// Migration `0010_phase03_baseline.sql` cleans up the now-retired
// 'poll.hot' / 'poll.warm' rows on the next deploy.
//
// We don't import pg-boss types directly here. RESEARCH.md flagged 10.x vs
// 12.x type drift; accepting a `MinimalBoss` interface keeps this module
// future-proof against pg-boss type churn.

export const QUEUES = {
  // Phase 1 + 02.2 — preserved.
  POLL_USER: "poll.user",
  POLL_COLD: "poll.cold",
  INTERNAL_HEALTHCHECK: "internal.healthcheck",
  // Phase 3.0 Plan 01 — DV-2 collapse: POLL_HOT renamed; POLL_WARM dropped.
  POLL_ACTIVE: "poll.active",
  // Phase 3.0 Plan 01 — D-NEW (Purge worker, Quota reset, Channel context backfill).
  PURGE_DAILY: "purge.daily",
  YOUTUBE_QUOTA_RESET: "youtube.quota_reset",
  YOUTUBE_CHANNEL_CONTEXT_BACKFILL: "youtube.channel_context_backfill",
  // Phase 3.0 Plan 09 — scheduler-tick queues (Pattern A from plan, recommended).
  // The cron schedules send empty {} jobs to these tick queues; the worker
  // subscribes and the handler calls enqueueActivePolls / enqueueColdPolls,
  // which then issues real per-event jobs to POLL_ACTIVE / POLL_COLD.
  // This separation keeps the scheduler-vs-worker contract clean: cron drives
  // ticks; ticks drive enqueue logic; enqueue logic drives real jobs.
  SCHEDULER_TICK_ACTIVE: "scheduler.tick.active",
  SCHEDULER_TICK_COLD: "scheduler.tick.cold",
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

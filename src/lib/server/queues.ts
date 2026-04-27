// pg-boss queue registry — single source of truth for queue names.
//
// RESEARCH.md "Phase-1-specific pitfall: pg-boss queue declaration drift" —
// pg-boss v10+ requires every queue to be created via `boss.createQueue()`
// before any `send()` or `work()` call. Forgetting to declare a queue causes
// silent loss-on-send. We mitigate by:
//   1. Centralizing every queue name in `QUEUES` (this module is the only
//      place the strings appear).
//   2. Exposing `declareAllQueues(boss)` so Plan 08's worker boot calls one
//      function and gets every Phase 1+ queue declared idempotently.
//
// Open Question Q1 (MEDIUM confidence) recommended declaring all four poll
// queues plus `internal.healthcheck` from Phase 1 even though Phase 1 runs
// no jobs — that locks the topology so Phase 3's workers can land without
// re-discussing queue boundaries.
//
// We don't import pg-boss types directly here. RESEARCH.md flagged 10.x vs
// 12.x type drift; accepting a `MinimalBoss` interface keeps this module
// future-proof against pg-boss type churn.

export const QUEUES = {
  POLL_HOT: "poll.hot",
  POLL_WARM: "poll.warm",
  POLL_COLD: "poll.cold",
  POLL_USER: "poll.user",
  INTERNAL_HEALTHCHECK: "internal.healthcheck",
} as const;

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

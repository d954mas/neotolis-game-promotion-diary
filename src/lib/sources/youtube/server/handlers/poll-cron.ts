// YouTube poll-cron handler.
//
// One handler subscribed to youtube.poll.cron, dispatching on
// job.data.tier ('active' | 'cold').
//
// The cron SCHEDULE itself is split via pg-boss v11+ key-based multiple
// schedules per queue:
//
//   await boss.schedule(
//     QUEUES.YOUTUBE_POLL_CRON,
//     "0 */6 * * *",
//     { tier: "active" },
//     { key: "active", tz: "America/Los_Angeles" },
//   );
//   await boss.schedule(
//     QUEUES.YOUTUBE_POLL_CRON,
//     "0 5 * * *",
//     { tier: "cold" },
//     { key: "cold", tz: "America/Los_Angeles" },
//   );
//
// Both schedules persist as separate rows in pgboss.schedule keyed by
// (queue_name, key); pg-boss v11+ allows multiple schedules per queue
// when the {key} option is provided.
//
// Adding a third tier (e.g. a future user-driven backfill cron) means
// adding a third boss.schedule call with a different key and extending
// this dispatch with another tier branch — the queue + handler topology
// stay flat.
//
// See sources/youtube/server/index.ts.scheduleCronTicks for the
// schedule registration.

import { handlePollActive } from "./poll-active.js";
import { handlePollCold } from "./poll-cold.js";

export type PollCronJob = {
  id?: string;
  data: { tier: "active" | "cold" } & Record<string, unknown>;
};

/**
 * Tier-tagged cron job dispatcher. Reads job.data.tier and routes to the
 * tier-specific handler. Throws on missing/invalid tier (load-bearing —
 * an unknown tier means the cron schedule was edited in the wrong place
 * or the payload shape drifted; better to surface loudly than silently
 * no-op).
 */
export async function handlePollCron(job: PollCronJob): Promise<void> {
  const tier = job.data.tier;
  if (tier === "active") {
    return handlePollActive({ id: job.id, data: { tier: "active" } });
  }
  if (tier === "cold") {
    return handlePollCold({ id: job.id, data: { tier: "cold" } });
  }
  throw new Error(
    `youtube.poll.cron job missing valid tier; got=${String(tier)} (expected 'active'|'cold')`,
  );
}

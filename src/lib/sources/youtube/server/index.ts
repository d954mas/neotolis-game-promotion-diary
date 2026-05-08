// YouTube per-source server barrel — Phase 03.0.1 D-14.
// Cross-source code (registry, worker entrypoints) imports from here.
// The internal modules (adapter, http, schema, handlers) are wired
// together inside this folder; consumers see only the adapter export.
//
// Phase 03.0.1 Plan 07 — per-kind queue topology landed (D-10..D-12).
// Queue rename map (Plan 05 → Plan 07):
//   poll.active                       → youtube.poll.cron (key=active)
//   poll.cold                         → youtube.poll.cron (key=cold)
//   poll.user                         → youtube.poll.user
//   (NEW)                             → youtube.backfill.user (Plan 10)
//   youtube.rehab_unavailable         → youtube.rehab (D-11 brevity)
//   youtube.quota_reset               → unchanged
//   youtube.channel_context_backfill  → unchanged
//
// Two scheduler.tick.* queues from Phase 03.0 Plan 09 are RETIRED here —
// collapsed into the youtube.poll.cron schedule via boss.schedule({key})
// per pg-boss v11+ multiple-schedules-per-queue. The poll-cron handler
// (./handlers/poll-cron.ts) reads job.data.tier and dispatches to
// handlePollActive / handlePollCold; the scheduler-tick → enqueue.ts hop
// is gone. Migration drizzle/0021_phase03_01_per_kind_queue_topology.sql
// cleans up the orphan pgboss.* rows.
//
// scheduleCronTicks is the REAL implementation — replaces the Plan 03
// throwing stub in ./adapter.ts. Cross-source crons (purge.daily,
// internal.healthcheck) stay in src/scheduler/index.ts because they
// apply across all sources, not just YouTube.
//
// batchSize values mirror the Phase 03.0 Plan 09 / Plan 05 contract:
//   YOUTUBE_POLL_CRON                 batchSize=4 (Active concurrency)
//   YOUTUBE_POLL_USER                 batchSize=2
//   YOUTUBE_BACKFILL_USER             batchSize=1 (Plan 10 wires the handler)
//   YOUTUBE_CHANNEL_CONTEXT_BACKFILL  batchSize=1
//   YOUTUBE_QUOTA_RESET               batchSize=1
//   YOUTUBE_REHAB                     batchSize=1
//
// The poll-cron handler internally distinguishes Active (cron every 6h,
// throttle skip on ninetyfive) vs Cold (cron daily 5am PT, throttle skip
// on eighty AND ninetyfive) via the tier-tagged payload. Cold's
// effectively-once-daily concurrency is shaped by the cron schedule, not
// by a separate queue's batchSize.

import type {
  AdapterContext,
  DataSourceAdapter,
  MinimalBoss,
  PollableSource,
} from "$lib/sources/adapter.js";
import { QUEUES } from "$lib/server/queues.js";
import { getBoss } from "$lib/server/queue-client.js";
import { youtubeChannelAdapter } from "./adapter.js";
import { handlePollCron } from "./handlers/poll-cron.js";
import { handlePollUser } from "./handlers/poll-user.js";
import { handleRehabUnavailable } from "./handlers/rehab-unavailable.js";
import { handleChannelContextBackfill } from "./handlers/channel-context-backfill.js";
import { handleQuotaReset } from "./handlers/quota-reset.js";
// Phase 03.0.1 Plan 10 — youtube.backfill.user handler. Plan 07 declared the
// queue (boss.createQueue) and left the subscription comment-only since the
// handler did not yet exist; Plan 10 fills both the producer side
// (backfillSource fires boss.send into this queue) and the consumer side
// (boss.work below dispatches each job to handleBackfillUser).
import { handleBackfillUser } from "./handlers/backfill-user.js";

async function registerQueues(boss: MinimalBoss): Promise<void> {
  // pg-boss v10+ requires createQueue before send/work — idempotent on
  // every boot. queues.ts.declareAllQueues() is still called at worker
  // bootstrap time for the cross-source roster; this function declares
  // the YouTube-specific queues again (idempotent) so the adapter's
  // registration is self-contained — Reddit/Twitter adapters follow the
  // same pattern in Phase 03.1+.
  await boss.createQueue(QUEUES.YOUTUBE_POLL_CRON);
  await boss.createQueue(QUEUES.YOUTUBE_POLL_USER);
  await boss.createQueue(QUEUES.YOUTUBE_BACKFILL_USER);
  await boss.createQueue(QUEUES.YOUTUBE_QUOTA_RESET);
  await boss.createQueue(QUEUES.YOUTUBE_REHAB);
  await boss.createQueue(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL);

  // youtube.poll.cron — Active+Cold collapsed via tier-tagged payload.
  // batchSize=4 matches Phase 03.0 POLL_ACTIVE concurrency (Cold's daily
  // cadence keeps it from saturating the budget regardless).
  await boss.work(QUEUES.YOUTUBE_POLL_CRON, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollCron(
        job as { id?: string; data: { tier: "active" | "cold" } & Record<string, unknown> },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_POLL_USER, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollUser(job as { id: string; data: { eventId: string; userId: string } });
    }
  });

  // Phase 03.0.1 Plan 10 — youtube.backfill.user worker subscription.
  // batchSize=1 mirrors channel-context-backfill (the backfill class of
  // queues stays single-stream so two clicks on the same source don't
  // race against each other; pg-boss singletonKey on the producer side is
  // the dedup gate, this batch size is the backstop).
  await boss.work(QUEUES.YOUTUBE_BACKFILL_USER, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillUser(
        job as {
          id?: string;
          data: { sourceId: string; userId: string; origin?: "user" | "cron" };
        },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleChannelContextBackfill(
        job as {
          id: string;
          data: {
            userId: string;
            channelId?: string;
            handleUrl?: string;
            sourceId?: string;
            backfillWindow?: "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
          };
        },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleQuotaReset(job as { id: string; data: object });
    }
  });

  await boss.work(QUEUES.YOUTUBE_REHAB, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleRehabUnavailable(job as { id: string });
    }
  });
}

/**
 * Plan 07 — REAL implementation (replaces the Plan 03 throwing stub in
 * ./adapter.ts). Registers the YouTube-specific cron schedules:
 *
 *   - youtube.poll.cron, key=active — every 6 hours UTC default. Sends
 *     `{ tier: "active" }` payload; the poll-cron handler dispatches.
 *   - youtube.poll.cron, key=cold   — daily 5am Pacific. Sends
 *     `{ tier: "cold" }` payload.
 *   - youtube.quota_reset           — midnight Pacific (YouTube's daily
 *     quota reset boundary).
 *   - youtube.rehab                 — weekly Sunday 4am Pacific (recovers
 *     privacy-unflipped videos; ~50 ids/week).
 *
 * Cross-source crons (purge.daily, internal.healthcheck) stay in
 * src/scheduler/index.ts — they apply across all sources, not just
 * YouTube. Plan 07 src/scheduler/index.ts iterates allAdapters and calls
 * adapter.scheduleCronTicks(boss) for each per-kind set.
 *
 * Pacific-time schedules use `tz: "America/Los_Angeles"` so DST
 * transitions are handled by pg-boss; the active tier's "every 6 hours"
 * cron is left as UTC default per Phase 03.0's existing precedent
 * (operator can revisit if the time-of-day shift matters at higher
 * volumes).
 */
async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — every 6 hours UTC (preserves Phase 03.0 cadence).
  await boss.schedule(
    QUEUES.YOUTUBE_POLL_CRON,
    "0 */6 * * *",
    { tier: "active" },
    { key: "active" },
  );
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.YOUTUBE_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Quota reset — midnight Pacific.
  await boss.schedule(
    QUEUES.YOUTUBE_QUOTA_RESET,
    "0 0 * * *",
    {},
    { tz: "America/Los_Angeles" },
  );
  // Rehab — weekly Sunday 4am Pacific.
  await boss.schedule(
    QUEUES.YOUTUBE_REHAB,
    "0 4 * * 0",
    {},
    { tz: "America/Los_Angeles" },
  );
}

/**
 * Plan 10 — REAL backfillSource (replaces the Plan 03 throwing stub in
 * ./adapter.ts). Fire-and-forget enqueue into youtube.backfill.user via the
 * APP-role pg-boss singleton (`getBoss()` — same accessor that
 * services/data-sources.ts uses to enqueue YOUTUBE_CHANNEL_CONTEXT_BACKFILL
 * on createSource).
 *
 * singletonKey=`backfill-${source.id}` dedups concurrent clicks: two POSTs
 * to /api/sources/:id/refresh-content within the pg-boss default singleton
 * window (~5min) coalesce into one job. The second POST returns the
 * pg-boss-supplied `null` jobId — the route still emits 202 Accepted with
 * a null jobId so the user-facing button optimistically reflects success
 * (the worker only needs to run once to surface new content).
 *
 * priority=1 puts user-initiated jobs ahead of cron-initiated polls in the
 * same queue (D-09 user-pool reserve). The worker's batchSize=1 means
 * priority is the only ordering knob that matters — no concurrent mixing.
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.YOUTUBE_BACKFILL_USER,
    {
      sourceId: source.id,
      userId: source.userId,
      origin: ctx.origin,
    },
    {
      singletonKey: `backfill-${source.id}`,
      priority: 1,
    },
  );
  return { jobId, queue: QUEUES.YOUTUBE_BACKFILL_USER };
}

// youtubeAdapter — composes the per-source adapter consumers see.
// Spread `youtubeChannelAdapter` (every other method: pollContent /
// pollStats / pollStatsByVideoId / parseUrl / observability /
// canRefreshPoll) with registerQueues + scheduleCronTicks + backfillSource
// OVERRIDDEN here as real implementations. The stubs in adapter.ts stay
// for typecheck-loud failure if a consumer imports adapter.ts directly
// instead of going through this barrel.
export const youtubeAdapter: DataSourceAdapter = {
  ...youtubeChannelAdapter,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
};

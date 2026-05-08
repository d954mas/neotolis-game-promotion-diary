// YouTube per-source server barrel — Phase 03.0.1 D-14.
// Cross-source code (registry, worker entrypoints) imports from here.
// The internal modules (adapter, http, schema, handlers) are wired
// together inside this folder; consumers see only the adapter export.
//
// Phase 03.0.1 Plan 05 — registerQueues lands as a REAL implementation
// here, OVERRIDING the throwing stub in ./adapter.ts. The stub remains
// in adapter.ts because the DataSourceAdapter contract requires every
// adapter object to expose every method (ContractError-loud is better
// than silently-undefined for premature use); the barrel composes the
// final adapter object that consumers actually receive.
//
// Queue NAMES are unchanged in this plan — poll.active / poll.cold /
// poll.user / youtube.channel_context_backfill / youtube.quota_reset /
// youtube.rehab_unavailable. The per-kind queue topology rename
// (youtube.poll.cron with key-based schedule split, youtube.poll.user,
// youtube.backfill.user) lands in Plan 07.
//
// Cross-source / non-per-kind queues (purge.daily, internal.healthcheck)
// are NOT registered here — they stay in src/worker/index.ts because
// they apply across all sources, not just YouTube.
//
// batchSize values mirror the existing src/worker/index.ts subscriptions
// pre-Plan 05 (Phase 3.0 Plan 09 contract):
//   POLL_ACTIVE                       batchSize=4
//   POLL_COLD                         batchSize=1
//   POLL_USER                         batchSize=2
//   YOUTUBE_CHANNEL_CONTEXT_BACKFILL  batchSize=1
//   YOUTUBE_QUOTA_RESET               batchSize=1
//   YOUTUBE_REHAB_UNAVAILABLE         batchSize=1

import type { DataSourceAdapter, MinimalBoss } from "$lib/sources/adapter.js";
import { QUEUES } from "$lib/server/queues.js";
import { youtubeChannelAdapter } from "./adapter.js";
import { handlePollActive } from "./handlers/poll-active.js";
import { handlePollCold } from "./handlers/poll-cold.js";
import { handlePollUser } from "./handlers/poll-user.js";
import { handleRehabUnavailable } from "./handlers/rehab-unavailable.js";
import { handleChannelContextBackfill } from "./handlers/channel-context-backfill.js";
import { handleQuotaReset } from "./handlers/quota-reset.js";

async function registerQueues(boss: MinimalBoss): Promise<void> {
  // pg-boss v10+ requires createQueue before send/work — idempotent on
  // every boot. queues.ts.declareAllQueues() is still called at worker
  // bootstrap time for cross-source queues; this function declares the
  // YouTube-specific queues again (idempotent) so the adapter's
  // registration is self-contained — Reddit/Twitter adapters follow the
  // same pattern in Phase 03.1+.
  await boss.createQueue(QUEUES.POLL_ACTIVE);
  await boss.createQueue(QUEUES.POLL_COLD);
  await boss.createQueue(QUEUES.POLL_USER);
  await boss.createQueue(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL);
  await boss.createQueue(QUEUES.YOUTUBE_QUOTA_RESET);
  await boss.createQueue(QUEUES.YOUTUBE_REHAB_UNAVAILABLE);

  await boss.work(QUEUES.POLL_ACTIVE, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollActive(job as { id: string; data: { videoIds: string[] } });
    }
  });

  await boss.work(QUEUES.POLL_COLD, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollCold(job as { id: string; data: { videoIds: string[] } });
    }
  });

  await boss.work(QUEUES.POLL_USER, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollUser(job as { id: string; data: { eventId: string; userId: string } });
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

  await boss.work(QUEUES.YOUTUBE_REHAB_UNAVAILABLE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleRehabUnavailable(job as { id: string });
    }
  });
}

// youtubeAdapter — composes the per-source adapter consumers see.
// Spread `youtubeChannelAdapter` (every other method: pollContent /
// pollStats / pollStatsByVideoId / parseUrl-stub / observability-stub /
// scheduleCronTicks-stub / backfillSource-stub / canRefreshPoll) with
// registerQueues OVERRIDDEN here as a real implementation. The stub in
// adapter.ts stays so consumers reading the type definition see the
// contract surface; the barrel is the runtime composition point.
export const youtubeAdapter: DataSourceAdapter = {
  ...youtubeChannelAdapter,
  registerQueues,
};

// Reddit per-source server barrel — DV-RDT-7 public-`.json` adapter.
//
// Cross-source code (registry, scheduler, worker, /admin/quota loader,
// /feed loader) imports ONLY from this file. Internal modules (adapter,
// http, schema, handlers, quota, observability, feed-enrichment) wire
// together inside this folder; consumers see only the `redditAdapter`
// export plus the `getRecentLoad` Reddit-specific helper.
//
// Per-kind queue topology (Phase 03.1):
//   - reddit.cron.enqueue-service-sources  — daily 00/06/12/18 UTC
//   - reddit.cron.enqueue-service-posts    — daily 03/09/15/21 UTC
//   - reddit.cron.baselines                — daily 04:00 UTC
//   - reddit.cron.deletion-propagation     — daily 05:00 UTC
//
// All four cron handlers do ZERO Reddit HTTP — they enqueue rows into
// reddit_refresh_queue (D-RDT-CRON-BURST). The actual HTTP fan-out
// happens via the 8-tick setInterval worker (D-RDT-WORKER) which drains
// reddit_refresh_queue at 8 req/min effective ceiling.
//
// scheduleCronTicks is the per-kind cron registration entrypoint. The
// cross-source scheduler (src/scheduler/index.ts) iterates allAdapters
// and calls adapter.scheduleCronTicks(boss) for each.
//
// registerQueues is the per-kind worker registration entrypoint. The
// cross-source worker (src/worker/index.ts) iterates allAdapters and
// calls adapter.registerQueues(boss). The Reddit batch-worker
// setInterval (worker-tick.ts) is booted separately in src/worker/index.ts
// — see the explicit setInterval block there (the pg-boss work() loop
// owns only the four cron queues; the 8-tick drain loop is direct).

import type {
  AdapterContext,
  DataSourceAdapter,
  MinimalBoss,
  PollableSource,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import { QUEUES } from "$lib/server/queues.js";
import { db } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import { redditAdapterCore } from "./adapter.js";
import { redditObservability } from "./observability.js";
import { enrichRedditFeedDtos } from "./feed-enrichment.js";
import { redditRefreshQueue } from "./schema/index.js";
import { handleEnqueueServiceSourcesCron } from "./handlers/enqueue-service-sources-cron.js";
import { handleEnqueueServicePostsCron } from "./handlers/enqueue-service-posts-cron.js";
import { handleBaselinesCron } from "./handlers/baselines-cron.js";
import { handleDeletionPropagationCron } from "./handlers/deletion-propagation-cron.js";

interface RedditSourceMetadata {
  username?: string;
  subreddit?: string;
}

/** registerQueues — pg-boss createQueue + work() for the FOUR Reddit
 *  cron-only pg-boss queues. The Reddit batch-worker setInterval drain
 *  loop (8-tick SQL FOR UPDATE SKIP LOCKED on reddit_refresh_queue) is
 *  booted separately in src/worker/index.ts; it doesn't go through
 *  pg-boss.work because pg-boss's concurrency model doesn't preserve the
 *  deterministic round-robin we need to stay inside Reddit's 10 req/min
 *  hard ceiling under multi-replica deploys (D-RDT-WORKER).
 *
 *  batchSize=1 on every cron handler — each handler is a once-per-tick
 *  DB scan + INSERT; concurrent runs would just contend on the same
 *  reddit_refresh_queue rows. */
async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_SOURCES);
  await boss.createQueue(QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_POSTS);
  await boss.createQueue(QUEUES.REDDIT_CRON_BASELINES);
  await boss.createQueue(QUEUES.REDDIT_CRON_DELETION_PROPAGATION);

  await boss.work(QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_SOURCES, { batchSize: 1 }, async (jobs) => {
    for (const _ of jobs) await handleEnqueueServiceSourcesCron();
  });
  await boss.work(QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_POSTS, { batchSize: 1 }, async (jobs) => {
    for (const _ of jobs) await handleEnqueueServicePostsCron();
  });
  await boss.work(QUEUES.REDDIT_CRON_BASELINES, { batchSize: 1 }, async (jobs) => {
    for (const _ of jobs) await handleBaselinesCron();
  });
  await boss.work(QUEUES.REDDIT_CRON_DELETION_PROPAGATION, { batchSize: 1 }, async (jobs) => {
    for (const _ of jobs) await handleDeletionPropagationCron();
  });
}

/** scheduleCronTicks — register the FOUR daily Reddit cron schedules.
 *  All UTC; Reddit's per-minute rate-limit budget is timezone-agnostic.
 *
 *    enqueue-service-sources  — 00/06/12/18 UTC (4×/day)
 *    enqueue-service-posts    — 03/09/15/21 UTC (4×/day, staggered)
 *    baselines                — 04:00 UTC daily
 *    deletion-propagation     — 05:00 UTC daily
 *
 *  Staggering against the service-sources cron lets the worker drain
 *  the queue between waves so the user-pool reservoir stays responsive
 *  to refresh-now clicks. */
async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  await boss.schedule(
    QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_SOURCES,
    "0 0,6,12,18 * * *",
    {},
    { tz: "UTC" },
  );
  await boss.schedule(
    QUEUES.REDDIT_CRON_ENQUEUE_SERVICE_POSTS,
    "0 3,9,15,21 * * *",
    {},
    { tz: "UTC" },
  );
  await boss.schedule(QUEUES.REDDIT_CRON_BASELINES, "0 4 * * *", {}, { tz: "UTC" });
  await boss.schedule(QUEUES.REDDIT_CRON_DELETION_PROPAGATION, "0 5 * * *", {}, { tz: "UTC" });
}

/** backfillSource — user-driven "Pull new content" / cron-driven
 *  initial-fetch. Enqueues an author_poll (reddit_account) or sub_poll
 *  (reddit_subreddit) row into reddit_refresh_queue.
 *
 *  Returns the inserted row's id (as a string for the cross-source
 *  contract — the queue is local to Reddit) and a queue label that
 *  matches the lane. The 8-tick worker drains the row asynchronously.
 *
 *  Origin → lane mapping (D-RDT-CAP-COUNTER):
 *    origin='user' → user_source lane (user_id NOT NULL — cap-counted)
 *    origin='cron' → service_source lane (user_id NULL — cap-exempt)
 *
 *  Priority 1 for user-driven (jumps the in-lane FIFO ahead of any
 *  stragglers); 0 for cron. Cross-lane fairness is owned by the 8-tick
 *  worker's REDDIT_SLOT_MAPPING. */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const md = (source.metadata ?? {}) as RedditSourceMetadata;
  const isAccount = typeof md.username === "string" && md.username.length > 0;
  const isSub = typeof md.subreddit === "string" && md.subreddit.length > 0;
  if (!isAccount && !isSub) {
    logger.warn(
      { sourceId: source.id },
      "redditAdapter.backfillSource: metadata missing username/subreddit; skipping enqueue",
    );
    return { jobId: null, queue: "reddit_refresh_queue:noop" };
  }
  const isUser = ctx.origin === "user";
  const queueName = isUser ? "user_source" : "service_source";
  const type = isAccount ? "author_poll" : "sub_poll";
  const payload = isAccount ? { handle: md.username! } : { sub: md.subreddit! };
  const result = await db
    .insert(redditRefreshQueue)
    .values({
      queueName,
      type,
      payload,
      userId: isUser ? ctx.userId : null,
      priority: isUser ? 1 : 0,
    })
    .returning({ id: redditRefreshQueue.id });
  return {
    jobId: result[0] ? String(result[0].id) : null,
    queue: `reddit_refresh_queue:${queueName}`,
  };
}

/** onSourceCreated — fire-and-forget initial backfill enqueue on
 *  registerSource. Mirrors YouTube's onSourceCreated pattern: the
 *  source row is the load-bearing return value; backfill enqueue is a
 *  nice-to-have that the user can re-trigger via Refresh-content if it
 *  silently fails.
 *
 *  Only fires when autoImport=true — passive registration (just
 *  tracking, no auto-pull) skips the enqueue. */
async function onSourceCreated(source: SourceCreatedHookSource): Promise<void> {
  if (!source.autoImport) return;
  try {
    await backfillSource(
      {
        id: source.id,
        userId: source.userId,
        metadata: source.metadata,
      },
      {
        userId: source.userId,
        // Onboarding is user-driven (they just pasted/registered the
        // source) so the row lands on user_source lane and counts
        // toward the per-user cap. Matches the YouTube auto-backfill
        // intent: explicit opt-in burns user pool.
        origin: "user",
      },
    );
  } catch (err) {
    logger.warn(
      { sourceId: source.id, err: String((err as Error)?.message ?? err) },
      "redditAdapter.onSourceCreated: backfill enqueue failed; ignoring (user can re-trigger)",
    );
  }
}

/**
 * redditAdapter — composes the polling core (./adapter.ts) with the
 * infrastructure-touching methods (registerQueues / scheduleCronTicks /
 * backfillSource / onSourceCreated) and the cross-source enrichment
 * hook (enrichFeedDtos). The TypeScript `: DataSourceAdapter` annotation
 * fails the build if any required contract method is missing from the
 * spread — completeness check by construction.
 *
 * SAME instance handles BOTH reddit_account and reddit_subreddit source
 * kinds — registry.ts wires both registry entries to this object. The
 * adapter dispatches internally on source.metadata (username vs
 * subreddit) inside pollContent / backfillSource. The declared `kind`
 * field reads "reddit_account" but cross-source code reads it only for
 * diagnostic logs; functional routing goes through registry lookups.
 */
export const redditAdapter: DataSourceAdapter = {
  ...redditAdapterCore,
  observability: redditObservability,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  onSourceCreated,
  enrichFeedDtos: enrichRedditFeedDtos,
};

// Re-export the Reddit-only observability helpers so /admin's Reddit
// Ops panel SSR loader (admin-quota-read.ts) and /sources's Reddit tab
// (plan 08) can import from this barrel rather than reaching into
// observability.ts directly.
export {
  getRecentLoad,
  getQueueDepth,
  getDailyByType,
  REDDIT_QUEUE_NAMES,
  REDDIT_QUEUE_TYPES,
} from "./observability.js";
export type {
  RedditQueueName,
  RedditQueueType,
  RedditQueueDepthRow,
  RedditDailyByType,
} from "./observability.js";

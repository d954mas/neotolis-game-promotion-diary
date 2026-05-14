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
  AdapterAppContext,
  AdapterContext,
  DataSourceAdapter,
  EventPreviewMetadata,
  MinimalBoss,
  PollableSource,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { Hono } from "hono";
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
import { handlePostSingle } from "./handlers/post-single.js";
import { redditParsePostUrl } from "./url.js";
import { isRedditConfigured } from "./credentials.js";
import { AdapterError } from "$lib/sources/errors.js";
import { redditMetadataRoutes } from "./route-metadata.js";

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
 * fetchEventPreviewMetadata — adapter wrapper for the /events/new
 * "Get from Reddit" button. Fetches /comments/<id>.json and returns
 * the post title + author + permalink in the cross-source
 * EventPreviewMetadata shape. Empty REDDIT_USER_AGENT → unreachable
 * (mirrors YouTube's empty-keys oEmbed behavior at the preview surface).
 *
 * Preview-only — no UPSERT, no snapshot row, no audit. The actual
 * persistent fetch happens later inside fetchEventStats on Submit.
 */
async function fetchEventPreviewMetadata(canonicalUrl: string): Promise<EventPreviewMetadata> {
  if (!isRedditConfigured()) {
    return { kind: "unreachable", cause: "reddit_not_configured" };
  }
  const parsed = redditParsePostUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_reddit_post" };
  }
  try {
    const result = await handlePostSingle({
      postId: parsed.externalId,
      userId: null, // preview is read-only; cap not enforced
      paste: true,
    });
    return {
      kind: "ok",
      title: result.title,
      authorName: result.author ?? "[deleted]",
      authorUrl:
        result.author !== null ? `https://www.reddit.com/user/${result.author}` : result.permalink,
      // Reddit doesn't expose thumbnails uniformly across post types;
      // self-text posts have none, link posts have a Reddit-hosted
      // preview that needs auth to render. Skip.
    };
  } catch (err) {
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      if (err.category === "operator-issue") {
        return { kind: "unreachable", cause: "reddit_not_configured" };
      }
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }
}

/**
 * fetchEventStats — synchronous stats fetch on /api/events POST so /feed
 * shows score/comments immediately. Mirrors YouTube's fetchEventStats:
 * the cross-source createEvent calls this AFTER the events INSERT, errors
 * are logged-and-swallowed by the caller.
 *
 * Side effects:
 *   - UPSERTs reddit_posts / reddit_users_cache / reddit_subreddits_cache
 *     via handlePostSingle
 *   - Writes ONE reddit_post_snapshots row (minute-truncated polled_at)
 *   - Writes ONE reddit_refresh_queue row with status='done' on the
 *     user_post lane so the post-refresh cap counter (D-RDT-CAP-POST,
 *     plan 06) sees this fetch. Without this, user pastes silently
 *     bypass the 25/5min cap.
 *
 * Returns {viewCount, likeCount, commentCount} where Reddit semantics
 * map: viewCount=score, likeCount=0 (Reddit has no separate likes —
 * score IS net upvotes), commentCount=num_comments. The cross-source
 * shape is preserved for UI parity; per-kind FeedCard enrichment
 * (feed-enrichment.ts) re-reads reddit_post_snapshots for the richer
 * Reddit-specific view (upvote_ratio, awards, removed_by_category).
 *
 * Returns null on disabled adapter or fetch failure — caller treats as
 * "stats unavailable, will be picked up by next cron tick".
 */
async function fetchEventStats(
  externalId: string,
  ctx: { userId: string },
): Promise<{ viewCount: number; likeCount: number; commentCount: number } | null> {
  if (!isRedditConfigured()) return null;
  try {
    const result = await handlePostSingle({
      postId: externalId,
      userId: ctx.userId,
      paste: true,
    });
    // Record the paste in reddit_refresh_queue so the post-refresh cap
    // counter (which COUNTs queue rows in the 5-minute window) sees this
    // user action. status='done' from the start — no worker tick will
    // re-claim it. last_attempt_at=NOW() matches what the worker would
    // have written, keeping the audit shape uniform across user-paste
    // and cron-drain code paths.
    await db.insert(redditRefreshQueue).values({
      queueName: "user_post",
      type: "post_single",
      payload: { post_id: externalId, flow: "paste" },
      userId: ctx.userId,
      priority: 0,
      status: "done",
      lastAttemptAt: new Date(),
    });
    return {
      viewCount: result.score ?? 0,
      likeCount: 0,
      commentCount: result.numComments ?? 0,
    };
  } catch (err) {
    logger.warn(
      { externalId, userId: ctx.userId, err: String((err as Error)?.message ?? err) },
      "redditAdapter.fetchEventStats failed; stats unavailable until next cron tick",
    );
    return null;
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
/**
 * registerRoutes — mounts /api/reddit/fetch-metadata on the shared Hono
 * app. Cross-source createApp() iterates allAdapters and calls
 * registerRoutes once at boot; adding a new source's preview endpoint
 * means implementing this method on the new adapter (mirror
 * src/lib/sources/youtube/server/index.ts registerRoutes).
 */
function registerRoutes(app: Hono<AdapterAppContext>): void {
  app.route("/api", redditMetadataRoutes);
}

export const redditAdapter: DataSourceAdapter = {
  ...redditAdapterCore,
  observability: redditObservability,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  onSourceCreated,
  enrichFeedDtos: enrichRedditFeedDtos,
  fetchEventPreviewMetadata,
  fetchEventStats,
  registerRoutes,
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

// Reddit per-source server barrel — the public-`.json` adapter (no
// OAuth, single User-Agent env var).
//
// Cross-source code imports ONLY from this file: it sees `redditAdapter`
// (the SourceAdapter implementation) plus a couple of Reddit-only
// observability helpers re-exported below. Internal modules — adapter,
// http, schema, handlers, quota, observability, feed-enrichment — wire
// together inside this folder.
//
// Cron handlers (registered via `scheduleCronTicks`) do ZERO Reddit
// HTTP themselves: they enqueue rows into `adapter_refresh_queue` and
// let the 8-tick batch-worker drain them at the 8 req/min ceiling. Cron
// queue handlers + the setInterval drain loop are bootstrapped from
// src/worker/index.ts via this barrel's `registerQueues`.
//
// `adapter_refresh_queue` is Reddit's durable queue table. The shared
// outbox is for pg-boss-backed side effects that need post-commit
// forwarding; Reddit queue producers insert directly into their final
// work table, usually inside the caller's transaction.

import type {
  AdapterAppContext,
  AdapterContext,
  AdapterPollState,
  BackfillWindow,
  SourceAdapter,
  EventKind,
  EventPreviewMetadata,
  MinimalBoss,
  NormalizeSourceInput,
  NormalizeSourceResult,
  PollableSource,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { Hono } from "hono";
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import {
  redditPosts,
  redditPostSnapshots,
  redditSubredditsCache,
  redditUsersCache,
} from "./schema/index.js";
import { QUEUES } from "$lib/server/queues.js";
import { db, type DbOrTx, type Tx } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { logger } from "$lib/server/logger.js";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";
import { writeAudit } from "$lib/server/audit.js";
import { redditAdapterCore } from "./adapter.js";
import { redditObservability } from "./observability.js";
import { enrichRedditFeedDtos } from "./feed-enrichment.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { handleEnqueueServiceSourcesCron } from "./handlers/enqueue-service-sources-cron.js";
import { handleEnqueueServicePostsCron } from "./handlers/enqueue-service-posts-cron.js";
import { handleBaselinesCron } from "./handlers/baselines-cron.js";
import { handleDeletionPropagationCron } from "./handlers/deletion-propagation-cron.js";
import { handlePostSingle } from "./handlers/post-single.js";
import {
  redditWorkerTick,
  REDDIT_SLOT_MAPPING,
  FALLTHROUGH_ORDER,
} from "./handlers/worker-tick.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { isRedditConfigured, assertRedditConfigured } from "./credentials.js";
import { AdapterError } from "$lib/sources/errors.js";
import { AppError } from "$lib/server/services/errors.js";
import { createRedditMetadataRoutes } from "./route-metadata.js";

interface RedditSourceMetadata {
  username?: string;
  subreddit?: string;
}

/** Shared Reddit cap gate. Both axes go through the same cross-source
 *  orchestrator (enforceAdapterUserQuota); the action argument picks the
 *  sliding-window axis ("post-refresh" or "source-action"). CYCLE-BREAKER:
 *  services/quota.ts imports the adapter registry which resolves this
 *  barrel — lazy import keeps the graph acyclic at module init. */
async function enforceRedditCap(args: {
  userId: string;
  ipAddress: string;
  action: "post-refresh" | "source-action";
}): Promise<void> {
  const { enforceAdapterUserQuota } = await import("$lib/server/services/quota.js");
  await enforceAdapterUserQuota(db, redditAdapter, args.userId, args.ipAddress, args.action, {
    platform: "reddit_account",
  });
}

async function handlePostSingleWithCapGate(args: {
  postId: string;
  userId: string;
  ipAddress: string;
}): Promise<Awaited<ReturnType<typeof handlePostSingle>>> {
  return handlePostSingle({
    postId: args.postId,
    userId: args.userId,
    paste: true,
    beforeFetch: () =>
      enforceRedditCap({
        userId: args.userId,
        ipAddress: args.ipAddress,
        action: "post-refresh",
      }),
  });
}

const redditMetadataRoutes = createRedditMetadataRoutes({
  fetchPostSingleWithCapGate: handlePostSingleWithCapGate,
});

async function normalizeSourceOnCreate(
  input: NormalizeSourceInput,
): Promise<NormalizeSourceResult> {
  assertRedditConfigured({ kind: input.kind });

  const parsed = redditParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      `handleUrl does not match a Reddit ${input.kind === "reddit_account" ? "user profile" : "subreddit"} URL`,
      "invalid_handle_url",
      422,
      { kind: input.kind, handleUrl: input.handleUrl },
    );
  }
  if (parsed.kind !== input.kind) {
    throw new AppError(
      `handleUrl shape (${parsed.kind}) does not match declared kind (${input.kind})`,
      "kind_url_inconsistent",
      422,
      { declaredKind: input.kind, parsedKind: parsed.kind, handleUrl: input.handleUrl },
    );
  }

  return {
    handleUrl: parsed.externalUrl,
    channelId: input.channelId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      ...(parsed.kind === "reddit_account"
        ? { username: parsed.handle }
        : { subreddit: parsed.handle }),
    },
  };
}

/** registerQueues — pg-boss createQueue + work() for the FOUR Reddit
 *  cron-only pg-boss queues. The Reddit batch-worker setInterval drain
 *  loop (8-tick SQL FOR UPDATE SKIP LOCKED on adapter_refresh_queue) is
 *  booted separately in src/worker/index.ts; it doesn't go through
 *  pg-boss.work because pg-boss's concurrency model doesn't preserve the
 *  deterministic round-robin we need to stay inside Reddit's 10 req/min
 *  hard ceiling under multi-replica deploys.
 *
 *  batchSize=1 on every cron handler — each handler is a once-per-tick
 *  DB scan + INSERT; concurrent runs would just contend on the same
 *  adapter_refresh_queue rows. */
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
 *  the queue between waves so user-driven refresh-now clicks stay responsive. */
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
 *  (reddit_subreddit) row into adapter_refresh_queue.
 *
 *  Returns the inserted row's id (as a string for the cross-source
 *  contract — the queue is local to Reddit) and a queue label that
 *  matches the lane. The 8-tick worker drains the row asynchronously.
 *
 *  origin → lane mapping:
 *    'user' → user_source  (user_id NOT NULL, counted by the user cap)
 *    'cron' → service_source (user_id NULL, exempt from the user cap)
 *
 *  Priority is symbolic here. user_source and service_source are
 *  separate lanes and the worker tick claims rows lane-by-lane via
 *  REDDIT_SLOT_MAPPING — within a single lane all backfill rows carry
 *  the same priority, so ordering effectively reduces to enqueued_at
 *  FIFO. The numeric difference (0 cron / 1 user) is preserved only as
 *  a hint for any future cross-lane query that might inspect it. */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  // Worker-config gate. The 8-tick batch-worker only boots when
  // isRedditConfigured() is true; without this guard, enqueued rows
  // would sit pending forever on an instance with empty REDDIT_USER_AGENT.
  assertRedditConfigured({ sourceId: source.id });
  const md = (source.metadata ?? {}) as RedditSourceMetadata;
  const isAccount = typeof md.username === "string" && md.username.length > 0;
  const isSub = typeof md.subreddit === "string" && md.subreddit.length > 0;
  if (!isAccount && !isSub) {
    logger.warn(
      { sourceId: source.id },
      "redditAdapter.backfillSource: metadata missing username/subreddit; skipping enqueue",
    );
    return { jobId: null, queue: adapterRefreshQueueLabel("reddit_account", "noop") };
  }
  const isUser = ctx.origin === "user";
  const queueName = isUser ? "user_source" : "service_source";
  const type = isAccount ? "author_poll" : "sub_poll";
  const payload = isAccount ? { handle: md.username! } : { sub: md.subreddit! };
  const dbCtx = ctx.tx ?? db;
  const result = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "reddit_account",
      queueName,
      type,
      payload,
      userId: isUser ? ctx.userId : null,
      priority: isUser ? 1 : 0,
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    jobId: result[0] ? String(result[0].id) : null,
    queue: adapterRefreshQueueLabel("reddit_account", queueName),
  };
}

/** onSourceCreated — initial backfill enqueue on registerSource.
 *  Runs inside createSource's transaction; the queue row must commit or
 *  roll back with the new source.
 *
 *  Only fires when autoImport=true — passive registration (just
 *  tracking, no auto-pull) skips the enqueue.
 *
 *  `backfillWindow` is part of the contract but not consumed here: Reddit's
 *  walker already gates each subscriber's fan-out against
 *  `source.backfillTargetSince` (which createSource derives from the same
 *  window), so re-reading the window here would be redundant. Accepted for
 *  contract conformance and forward-compat with future per-window tuning. */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow; tx: Tx },
): Promise<void> {
  if (!source.autoImport) return;
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
      tx: opts.tx,
    },
  );
}

/**
 * fetchEventPreviewMetadata — adapter wrapper for the /events/new
 * "Get info" button + the generic POST /api/events/preview-url
 * cross-source endpoint. Fetches /api/info.json?id=t3_X via
 * handlePostSingle (which UPSERTs caches + writes a snapshot row +
 * records a cap-counter row when userId is non-null) and returns the
 * post title + author + permalink in the cross-source
 * EventPreviewMetadata shape.
 *
 * NOT preview-only — /api/info is the same fetch the paste flow uses,
 * so we share the side effects (cache populated, snapshot recorded)
 * instead of doing a read-only fetch and then re-fetching on Submit.
 * handlePostSingle's 60s dedup ensures preview + Submit on the same
 * post produces ONE Reddit request and ONE cap-counter increment.
 *
 * Cap enforcement: ctx.userId is threaded into handlePostSingle's
 * userId param. Both the Reddit-specific route
 * (/api/reddit/fetch-metadata) and the generic preview-url route
 * (/api/events/preview-url) flow through here, so both paths land the
 * user_post `done` row that feeds the 25/5min post-refresh cap and
 * fire the `beforeFetch` gate that throws 429 on cap exhaustion. Pre-
 * fix: the generic preview endpoint called this with userId=null,
 * burning a Reddit unit without writing the counter — a silent bypass.
 *
 * Empty REDDIT_USER_AGENT → unreachable (mirrors YouTube's empty-keys
 * oEmbed behavior at the preview surface).
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  if (!isRedditConfigured()) {
    return { kind: "unreachable", cause: "reddit_not_configured" };
  }
  const parsed = redditParsePostUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_reddit_post" };
  }
  try {
    const result = await handlePostSingleWithCapGate({
      postId: parsed.externalId,
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
    });
    return {
      kind: "ok",
      title: result.title,
      authorName: result.author ?? "[deleted]",
      authorUrl:
        result.author !== null ? `https://www.reddit.com/user/${result.author}` : result.permalink,
      occurredAt: result.submittedAt,
      // Reddit doesn't expose thumbnails uniformly across post types;
      // self-text posts have none, link posts have a Reddit-hosted
      // preview that needs auth to render. Skip.
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
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
 * fetchSyncStats — synchronous stats fetch on /api/events POST so /feed
 * shows score/comments immediately. Mirrors YouTube's syncStats.fetch:
 * the cross-source createEvent calls this AFTER the events INSERT, errors
 * are logged-and-swallowed by the caller.
 *
 * Side effects (all owned by handlePostSingle — this wrapper just
 * shapes the return type to the cross-source contract):
 *   - UPSERTs reddit_posts / reddit_users_cache / reddit_subreddits_cache
 *   - Writes ONE reddit_post_snapshots row (minute-truncated polled_at)
 *   - Writes ONE adapter_refresh_queue row with status='done' on the
 *     user_post lane for cap-counter visibility (the 25/5min post-refresh
 *     cap reads from this lane).
 *   - 60s dedup — preview+submit on the same post collapses to ONE
 *     Reddit fetch + ONE cap-counter tick
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
async function fetchSyncStats(
  externalId: string,
  ctx: { userId: string; ipAddress?: string },
): Promise<{
  viewCount: number;
  likeCount: number;
  commentCount: number;
  authorIsMe?: boolean;
} | null> {
  if (!isRedditConfigured()) return null;
  try {
    const result = await handlePostSingleWithCapGate({
      postId: externalId,
      userId: ctx.userId,
      ipAddress: ctx.ipAddress ?? "0.0.0.0",
    });
    // author-is-me inheritance: match t3.author against the user's
    // owned reddit_account sources. If found, signal author_is_me=true
    // back to createEvent so the events row is created with proper
    // attribution. Reddit usernames are case-insensitive, while the API
    // can return registered casing that differs from the pasted source.
    let authorIsMe: boolean | undefined = undefined;
    if (result.author !== null) {
      authorIsMe = await isOwnedRedditAuthor(ctx.userId, result.author);
    }

    const isFreshFetch = result.fetched === true;

    // Cross-source audit parity. YouTube's syncStats.fetch writes an
    // event.poll_refreshed audit row with flow=stats_refresh so the
    // /admin dashboards' SUM-by-audit-log surface (getUserQuotaUsedToday)
    // sees the request. Reddit's cap-counter lives on adapter_refresh_queue
    // (already incremented inside handlePostSingle), so this audit row
    // is for read-side parity only — it does NOT participate in
    // enforceAdapterUserQuota. Without it, getUserQuotaUsedToday(userId,
    // "reddit_account") would return 0 always.
    // platform is ADAPTER-scoped (not source-scoped) — the Reddit adapter
    // serves both reddit_account and reddit_subreddit SourceKinds via
    // the same code path; cross-source dashboards lump them under the
    // adapter's primary source kind. If a future report needs a
    // per-SourceKind breakdown, it should JOIN events.source_id →
    // data_sources.kind instead of reading this audit metadata.
    await writeAudit({
      userId: ctx.userId,
      action: "event.poll_refreshed",
      ipAddress: ctx.ipAddress ?? "0.0.0.0",
      metadata: {
        external_id: externalId,
        kind: "reddit_post",
        platform: "reddit_account",
        flow: "stats_refresh",
        requests_used: isFreshFetch ? 1 : 0,
        events_inserted: 0,
      },
    });

    return {
      viewCount: result.score ?? 0,
      likeCount: 0,
      commentCount: result.numComments ?? 0,
      authorIsMe,
    };
  } catch (err) {
    logger.warn(
      { externalId, userId: ctx.userId, err: String((err as Error)?.message ?? err) },
      "redditAdapter.syncStats.fetch failed; stats unavailable until next cron tick",
    );
    return null;
  }
}

/**
 * resetWalkerStateOnWidening — cross-source hook fired by updateSource
 * when the user widens `backfillTargetSince` past the prior value. For
 * Reddit the walker state lives on the public cross-tenant cache row
 * (reddit_subreddits_cache / reddit_users_cache); resetting it means:
 *   1. Clear backfill_after_cursor + flip backfill_complete=false so
 *      sub_poll / author_poll re-enter "deep walk" mode on the next tick.
 *   2. Enqueue a user_source row to kick the walker off immediately —
 *      same lane the user's original click would have used, same cap
 *      bookkeeping. After this initial click runs through one page,
 *      sub_poll's continuation enqueue takes over on the service lane.
 *
 * Cap: counts toward the user's source-action cap via enforceAdapterUserQuota
 * — a PATCH widen burns the same kind of budget as a refresh-content click.
 * Other subscribers of the same subreddit / user free-ride on the resulting
 * fan-out (events show up in their feeds too, filtered to their own
 * backfillTargetSince via the inner-loop window check in sub-poll.ts).
 *
 * Skips when: source.metadata doesn't carry the lookup key (defensive —
 * createSource pipeline always sets it), OR the cache row is missing
 * (handler will create the row on first walk anyway), OR walker already
 * marked NOT-complete (next refresh will continue the deep walk on its
 * own without needing a reset).
 */
async function resetWalkerStateOnWidening(
  source: SourceCreatedHookSource,
  ctx: {
    previousTarget: Date | null;
    newTarget: Date;
    triggerUserId: string;
    ipAddress: string;
    tx: Tx;
  },
): Promise<void> {
  // Worker-config gate — same rationale as backfillSource.
  assertRedditConfigured({ sourceId: source.id });
  const meta = (source.metadata ?? {}) as { subreddit?: string; username?: string };
  let resetCount: number;
  let queuePayload: { sub?: string; handle?: string };
  let pollType: "sub_poll" | "author_poll";

  if (source.kind === "reddit_subreddit" && typeof meta.subreddit === "string") {
    const result = await ctx.tx
      .update(redditSubredditsCache)
      .set({ backfillAfterCursor: null, backfillComplete: false })
      .where(
        and(
          eq(redditSubredditsCache.name, meta.subreddit),
          eq(redditSubredditsCache.backfillComplete, true),
        ),
      )
      .returning({ name: redditSubredditsCache.name });
    resetCount = result.length;
    queuePayload = { sub: meta.subreddit };
    pollType = "sub_poll";
  } else if (source.kind === "reddit_account" && typeof meta.username === "string") {
    const result = await ctx.tx
      .update(redditUsersCache)
      .set({ backfillAfterCursor: null, backfillComplete: false })
      .where(
        and(
          eq(redditUsersCache.username, meta.username),
          eq(redditUsersCache.backfillComplete, true),
        ),
      )
      .returning({ username: redditUsersCache.username });
    resetCount = result.length;
    queuePayload = { handle: meta.username };
    pollType = "author_poll";
  } else {
    // No metadata key to look up — never-walked source (first walk hasn't
    // landed yet) or non-Reddit kind. updateSource only routes to the
    // adapter for `source.kind` matching the adapter registry entry so
    // the else-branch effectively never fires for Reddit; defense-in-depth.
    return;
  }

  if (resetCount === 0) {
    // The cache row was either missing OR backfill_complete was already
    // false — in either case the next worker tick already does the right
    // thing (deep walk runs against the existing-or-fresh cursor). No
    // continuation enqueue needed; the user's natural next refresh OR
    // the daily service_source cron picks it up.
    logger.debug(
      { kind: source.kind, meta, triggerUserId: ctx.triggerUserId },
      "reddit.resetWalkerStateOnWidening: cache row not in complete state; no-op",
    );
    return;
  }

  // Per-user fair-share cap check — mirrors the source-action gate that
  // POST /api/sources/:id/refresh-content runs before enqueue. Without
  // this, a user already exhausted on the Reddit source-action sliding
  // window could trigger a fresh deep walk through PATCH widening, which
  // is the exact bypass already closed for the YouTube widen path. Runs
  // BEFORE the enqueue so the 429 surface stays consistent with other
  // refresh-content flows.
  await enforceRedditCap({
    userId: ctx.triggerUserId,
    ipAddress: ctx.ipAddress,
    action: "source-action",
  });

  // Enqueue an immediate user_source kick. user_id=triggerUserId so the
  // PATCH counts the same as a refresh-content click against the user's
  // source-action cap (and surfaces as such in observability audit).
  await ctx.tx.insert(adapterRefreshQueue).values({
    adapterKind: "reddit_account",
    queueName: "user_source",
    type: pollType,
    payload: queuePayload,
    userId: ctx.triggerUserId,
    priority: 1,
  });
}

/** Shape consumed by /events/[id] page UI. Cross-source `+page.server.ts`
 *  imports `loadRedditEventDetailPreview` from this barrel rather than
 *  reaching into `reddit_posts` directly — keeps the per-source DB schema
 *  encapsulated behind the adapter. NULL means the worker / paste flow
 *  hasn't populated the row yet; the UI falls back to event.title alone. */
export interface RedditEventDetailPreview {
  author: string | null;
  subreddit: string;
  permalink: string;
  title: string;
  metadata: unknown;
}

/** Read the `reddit_posts` cache row for the event-detail page preview
 *  (link_url, body_excerpt, is_self, flair carried in `metadata`). Accepts
 *  either bare ("abc123") or t3-form ("t3_abc123") external id and
 *  normalises to the t3 form the cache PK uses. */
export async function loadRedditEventDetailPreview(
  externalId: string,
): Promise<RedditEventDetailPreview | null> {
  const tFormId = externalId.startsWith("t3_") ? externalId : `t3_${externalId}`;
  const [r] = await db
    .select({
      author: redditPosts.author,
      subreddit: redditPosts.subreddit,
      permalink: redditPosts.permalink,
      title: redditPosts.title,
      metadata: redditPosts.metadata,
    })
    .from(redditPosts)
    .where(eq(redditPosts.postId, tFormId))
    .limit(1);
  return r ?? null;
}

/** Lookup: does the user have an owned, non-soft-deleted reddit_account
 *  source whose metadata.username matches the post author? Tenant-scoped
 *  by construction (filters by userId). */
async function isOwnedRedditAuthor(userId: string, author: string): Promise<boolean> {
  const rows = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.kind, "reddit_account"),
        eq(dataSources.isOwnedByMe, true),
        isNull(dataSources.deletedAt),
        sql`lower(${dataSources.metadata}->>'username') = lower(${author})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * redditAdapter — composes the polling core (./adapter.ts) with the
 * infrastructure-touching methods (registerQueues / scheduleCronTicks /
 * backfillSource / onSourceCreated) and the cross-source enrichment
 * hook (enrichFeedDtos). The TypeScript `SourceAdapter & typeof core` annotation
 * fails the build if any required contract method is missing from the
 * spread — completeness check by construction.
 *
 * SAME instance handles BOTH reddit_account and reddit_subreddit source
 * kinds — registry.ts wires both registry entries to this object. The
 * adapter dispatches internally on source.metadata (username vs
 * subreddit) inside backfillSource. The declared `kind`
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

/**
 * fetchPollStateMap — batch lookup of {publishedAt, lastPolledAt, lastPollStatus}
 * keyed by externalId, consumed by the cross-source `loadVideoDataForEvents` overlay
 * in `dto.ts`. PollingBadge + RefreshNowButton wake up once these three fields are
 * non-null on the EventDto.
 *
 * Inputs may come in either Reddit id form — bare `abc123` or t3 `t3_abc123` —
 * because events.externalId is written in either form depending on which ingest
 * path created the row. `reddit_posts.post_id` is the t3 form; we normalize to it
 * for the SELECT and then return BOTH forms in the result Map so the caller's
 * lookup hits regardless of which form the events row carries.
 *
 * Reddit's per-post tables are PUBLIC-DATA (no user_id). The userId argument is
 * accepted for the contract but unused — upstream `loadVideoDataForEvents`
 * already filters by tenant before this is called.
 */
async function fetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;

  // Normalize both directions: caller may pass bare id or t3 form; DB stores t3.
  const tFormIds = new Set<string>();
  for (const id of externalIds) {
    tFormIds.add(id.startsWith("t3_") ? id : `t3_${id}`);
  }
  const lookup = [...tFormIds];

  // `last_snapshot_at` on reddit_posts is an EXACT (non-truncated) wall-clock
  // timestamp stamped by upsertRedditPost on every UPSERT (i.e. every successful
  // poll). `reddit_post_snapshots.polled_at` is minute-truncated for in-bucket
  // idempotency, so it's NOT usable for the "did the poll finish after the
  // user's refresh click?" comparison that PollingBadge.refreshQueued runs.
  // Using last_snapshot_at here lets the badge correctly flip from
  // "Refresh queued" → "Updated just now" within seconds of the worker tick.
  const postRows = await db
    .select({
      postId: redditPosts.postId,
      submittedAt: redditPosts.submittedAt,
      lastSnapshotAt: redditPosts.lastSnapshotAt,
    })
    .from(redditPosts)
    .where(inArray(redditPosts.postId, lookup));

  // Latest snapshot row still scanned for `status` — that field doesn't live
  // on reddit_posts (it's per-snapshot lifecycle: ok / removed / archived /
  // not_found). ORDER BY post_id, polled_at DESC + manual DISTINCT ON picks
  // the freshest row per post.
  const snapRows = await db
    .select({
      postId: redditPostSnapshots.postId,
      status: redditPostSnapshots.status,
    })
    .from(redditPostSnapshots)
    .where(inArray(redditPostSnapshots.postId, lookup))
    .orderBy(redditPostSnapshots.postId, desc(redditPostSnapshots.polledAt));

  const latestStatus = new Map<string, string>();
  for (const r of snapRows) {
    if (latestStatus.has(r.postId)) continue;
    latestStatus.set(r.postId, r.status);
  }

  for (const p of postRows) {
    const state: AdapterPollState = {
      publishedAt: p.submittedAt,
      lastPolledAt: p.lastSnapshotAt,
      lastPollStatus: latestStatus.get(p.postId) ?? null,
    };
    map.set(p.postId, state);
    // Also publish under the bare-id key so callers that key on the form
    // stored on events.externalId hit regardless of which form was used.
    if (p.postId.startsWith("t3_")) map.set(p.postId.slice(3), state);
  }
  return map;
}

function validateEventInput(input: { kind: string; url?: string | null }): void {
  if (input.kind !== "reddit_post") return;
  if (!input.url) {
    throw new AppError("url is required when kind=reddit_post", "kind_url_inconsistent", 422, {
      reason: "reddit_post_requires_url",
    });
  }
  const parsed = redditParsePostUrl(input.url);
  if (parsed === null || parsed.kind !== "reddit_post") {
    throw new AppError("url is not a recognized Reddit post URL", "kind_url_inconsistent", 422, {
      reason: "url_not_reddit_post",
    });
  }
}

/**
 * enqueueRefreshNow — adapter-driven Refresh-Now enqueue. The
 * cross-source `requestRefreshPoll` service runs validation / cap
 * / cooldown gates, then asks the adapter to actually enqueue the
 * refresh. Reddit: INSERT a user_post row into adapter_refresh_queue
 * (the 8-tick worker drains it within ~7.5s of enqueue at the latest
 * effective ceiling). YouTube's equivalent uses the same shared table on
 * the user_video lane.
 *
 * Dedup: refresh-poll.ts has already eager-written
 * events.metadata.last_user_refresh_at and atomic-checked the cooldown
 * gate, so two-clicks-in-same-minute is already filtered out upstream.
 * We do NOT also dedup against pending queue rows here — the user
 * clicked Refresh-Now consciously and expects a fresh stats fetch,
 * which dedup against an already-pending row would silently suppress.
 */
async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  // Worker-config gate — same rationale as backfillSource.
  assertRedditConfigured({ eventId: input.eventId });
  // externalId stored on events is the bare Reddit id (e.g. "abc123");
  // handlePostSingle accepts either form and t3-normalizes internally.
  //
  // priority is signed smallint; adapter_refresh_queue workers sort
  // ORDER BY priority ASC (lower = ahead). Cron/paste rows use 0/1;
  // refresh-now is the user-waiting path, so -10 puts it ahead of
  // background work. YouTube uses the same convention on its SQL queue.
  const dbCtx = input.tx ?? db;
  const [row] = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "reddit_account",
      queueName: "user_post",
      type: "post_single",
      payload: { post_id: input.externalId, flow: "refresh-now" },
      userId: input.userId,
      priority: -10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    queue: adapterRefreshQueueLabel("reddit_account", "user_post"),
    jobId: row ? String(row.id) : null,
  };
}

export const redditAdapter: SourceAdapter & typeof redditAdapterCore = {
  ...redditAdapterCore,
  observability: redditObservability,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  normalizeSourceOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  enrichFeedDtos: enrichRedditFeedDtos,
  fetchEventPreviewMetadata,
  syncStats: {
    fetch: fetchSyncStats,
  },
  registerRoutes,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "reddit_post",
    enqueue: enqueueRefreshNow,
  },
  workQueue: {
    scheduledWorkers: [
      {
        name: "reddit.refresh",
        intervalMs: 7500,
        readyMessage: "reddit batch-worker ready: 8-tick round-robin loop",
        disabledMessage: "reddit batch-worker disabled",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: "reddit_account",
          slots: REDDIT_SLOT_MAPPING,
          fallthrough: FALLTHROUGH_ORDER,
        },
        replicaPolicy: "parallel",
        isEnabled: isRedditConfigured,
        tick: redditWorkerTick,
      },
    ],
  },
  validateEventInput,
  fetchPollStateMap,
};

// Re-export the Reddit-only observability helpers so /admin's Reddit
// Ops panel SSR loader and /sources's Reddit tab import from this
// barrel rather than reaching into observability.ts directly.
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

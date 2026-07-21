// Shared Reddit feed-walk core for BOTH walkers (author-search + native subreddit).
//
// The author walker (reddit_account, handlers/backfill-account.ts) and the subreddit
// walker (reddit_subreddit, handlers/backfill-subreddit.ts) share EVERYTHING except
// the ScrapeCreators feed mode + the reconciliation subject column — so the walk /
// snapshot-write / event fan-out / Variant-A deletion reconciliation / channel-state
// bookkeeping live here ONCE, parameterized by a WalkConfig. The two handler files
// are thin wrappers that bind the mode + subject + queue (mirrors the shared
// social-warm-lane factory pattern — one money-path spelling, per-kind config).
//
// COVERAGE-PASS PER INVOCATION (deviation from twitter's one-page-per-tick):
// Variant-A deletion detection (12-SPIKE "Deletion-propagation Variant A") needs the
// COMPLETE set of post ids a coverage pass saw to decide which tracked posts
// DISAPPEARED. That set cannot be assembled one-page-per-tick without persisting a
// growing seen-set across ticks, so the walk loops pages within ONE invocation to a
// bounded coverage boundary, then reconciles. ScrapeCreators has no per-account QPS
// ceiling (unlike twitterapi.io), so a bounded multi-page loop is cheap + safe.
//
// COST CAPS (12-SPIKE "Cost caps"):
//   - INITIAL / deep backfill: walk to end-of-feed OR SOCIAL_BACKFILL_MAX_POSTS (100)
//     OR the depth-bound date — one-time, bounds the archive pull.
//   - DAILY INCREMENTAL poll: bounded to K = INCREMENTAL_PAGE_CAP (2) pages — the
//     firehose bound. A busy subreddit is capped to ~2 credits/poll; a legit
//     low-traffic source hits end-of-feed / the window first.
//   - A LEGIT low-traffic source lands at ≤~5 credits/day: K=2 daily walk + at most ~1
//     warm one-shot catch per post that fell off the walk. A mistaken FIREHOSE source is
//     NOT bounded to ~5/day by the per-tick warm cap (see warm-eligibility.ts SCOPE note)
//     — its hard ceiling is the inherited per-user LIMIT_SOCIAL_REQUESTS_PER_DAY + the
//     operator 80/95% budget throttle (the real money stops).

import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";
import { writeAuditStrict } from "$lib/server/audit.js";
import {
  markSourceNeedsReconnect,
  clearNeedsReconnect,
} from "$lib/server/services/data-sources.js";
import {
  getChannelState,
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
} from "$lib/server/services/channel-state.js";
import { AdapterError } from "$lib/sources/errors.js";
import { getSocialProvider } from "../provider/registry.js";
import { fetchRedditFeedPage, type RedditFeedMode } from "../provider/scrapecreators-reddit.js";
import { writeSnapshot, upsertRedditAccount, upsertRedditSubreddit } from "../snapshots.js";
import { buildRedditTitle, type NormalizedRedditPost } from "../normalize.js";
import { readRedditBackfillState, writeRedditBackfillState } from "../backfill-state.js";
import type { RedditSourceKind } from "../backfill-state.js";
import type { RawEvent } from "$lib/sources/adapter.js";

export type RedditWalkFlow = "initial" | "incremental" | "historical" | "auto_passive";

export interface RedditWalkJob {
  id?: string;
  data: {
    kind: RedditSourceKind;
    /** The lowercase username (author) or subreddit slug (subreddit) = channelKey. */
    channelKey: string;
    /** UserId who triggered this walk. Undefined for cron — the trigger user pays
     *  the per-user cap; cron continuation runs on the cron pool. */
    triggerUserId?: string;
    /** Walk depth target — earliest publishedAt to walk to (ISO 8601). */
    depthBoundIso: string;
    flow: RedditWalkFlow;
    forceDeep?: boolean;
  };
}

export interface RedditWalkConfig {
  kind: RedditSourceKind;
  mode: RedditFeedMode;
  queue: string;
}

/** Daily incremental firehose bound (12-SPIKE cost caps: K=2). */
const INCREMENTAL_PAGE_CAP = 2;
/** Safety ceiling on the deep/initial loop (page count) — bounds the one-time pull
 *  even if SOCIAL_BACKFILL_MAX_POSTS is set huge. 100 posts / ~7-24 per page ⇒ well
 *  under this. */
const DEEP_PAGE_CAP = 30;

/** Map one NormalizedRedditPost → the cross-source RawEvent. Title = the post
 *  headline (falls back to the self-text body first line, then a date fallback). */
function postToRawEvent(post: NormalizedRedditPost): RawEvent {
  const fallbackUrl = `https://www.reddit.com/comments/${post.id.replace(/^t3_/, "")}`;
  const title =
    buildRedditTitle(post.title) || buildRedditTitle(post.selftext) || `Reddit post · ${post.id}`;
  return {
    externalId: post.id,
    url: post.permalink ?? fallbackUrl,
    title,
    occurredAt: post.publishedAt,
    kind: "reddit_post",
    metadata: {
      media_type: post.mediaType,
      thumbnail_url: post.thumbnailUrl,
      subreddit: post.subredditSlug,
    },
  };
}

export async function runRedditWalk(job: RedditWalkJob, config: RedditWalkConfig): Promise<void> {
  const { channelKey, triggerUserId } = job.data;
  const kind = job.data.kind;
  let flow: RedditWalkFlow = job.data.flow ?? "auto_passive";

  if (typeof channelKey !== "string" || channelKey === "" || kind !== config.kind) {
    logger.warn(
      { jobId: job.id, payload: job.data },
      `${config.queue}: malformed payload (missing/mismatched kind/channelKey); skipping`,
    );
    return;
  }

  // Active subscribers for this channel. CROSS-TENANT BY DESIGN — channel-scoped
  // fan-out (channelKey is the immutable username/slug, stored on channelId).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, config.kind),
        eq(dataSources.channelId, channelKey),
        isNull(dataSources.deletedAt),
      ),
    );
  if (subscribers.length === 0) {
    logger.info({ jobId: job.id, channelKey }, `${config.queue}: no active subscribers; skipping`);
    return;
  }

  const provider = getSocialProvider("reddit");
  if (provider === null) {
    // SOC-05 graceful degrade — provider not configured (flag off). No-op; the cron
    // lane should not have enqueued this, but be defensive (no throw, no orphan row).
    logger.info(
      { jobId: job.id, channelKey },
      `${config.queue}: provider not configured; degrading to no-op`,
    );
    return;
  }

  const channelState = await getChannelState(config.kind, channelKey);
  const wasNeverPolled = channelState === undefined || channelState.lastPolledAt === null;

  const target = new Date(job.data.depthBoundIso);
  if (Number.isNaN(target.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      `${config.queue}: invalid depthBoundIso; skipping`,
    );
    return;
  }

  const deepestWalked = channelState?.backfillOldestAt ?? null;
  let branch: "exhausted" | "incremental" | "deep";
  if (job.data.forceDeep === true) branch = "deep";
  else if (channelState?.backfillComplete === true) branch = "exhausted";
  else if (deepestWalked !== null && target.getTime() >= deepestWalked.getTime())
    branch = "incremental";
  else branch = "deep";

  const isDeep = branch === "deep";
  const maxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const pageCap = isDeep ? DEEP_PAGE_CAP : INCREMENTAL_PAGE_CAP;
  const origin: "cron" | "user" = triggerUserId ? "user" : "cron";

  // Resumable single-feed state. Incremental/exhausted branches sweep from page 1
  // (cursor null, count reset); deep resumes from the persisted cursor.
  let state = readRedditBackfillState(channelState);
  if (!isDeep) {
    state = { cursor: null, complete: false, collected: 0, operatorPaused: state.operatorPaused };
  }
  // Only a pass that STARTED at the top of the feed (cursor null) has coverage that is
  // contiguous down from "now" to oldestSeen — the precondition Variant-A reconciliation
  // relies on. A RESUMED deep tick (cursor already set) walks only older pages this
  // invocation; its seenIds miss the newer-but-alive posts collected in earlier ticks, so
  // reconciling [oldestSeen, now] would false-mark them deleted. Skip reconcile in that case.
  const startedFromTop = state.cursor === null;

  const collectedEvents: RawEvent[] = [];
  const seenIds: string[] = [];
  let oldestSeenPublishedAt: Date | null = null;
  let requestsUsed = 0;
  let pausedByBudget = false;
  let pausedByRateLimit = false;
  let notFound = false;
  let walkedThisTick = false;
  let fetchedThisTick = 0;
  let crossedBound = false;

  // ── Walk pages within this invocation to the branch's coverage boundary ──
  for (let pageNo = 0; pageNo < pageCap; pageNo++) {
    if (state.complete) break;
    // Deep cap reached at a page boundary: stop WITHOUT marking complete (the feed may
    // have more) — a partial pass, so reconciliation is skipped (coveragePassComplete
    // reads state.complete).
    if (isDeep && state.collected >= maxPosts) break;
    walkedThisTick = true;

    let page: Awaited<ReturnType<typeof fetchRedditFeedPage>>;
    try {
      page = await fetchRedditFeedPage(config.mode, channelKey, state.cursor, { origin });
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.category === "rate-limited") {
          pausedByRateLimit = true;
        } else if (err.category === "operator-issue") {
          pausedByBudget = true;
        } else if (err.category === "not-found") {
          notFound = true;
        } else {
          throw err; // transient / permanent → pg-boss retry / dead-letter
        }
      } else {
        throw err;
      }
      break;
    }

    requestsUsed += page.creditsUsed;
    fetchedThisTick += page.posts.length;

    for (const post of page.posts) {
      // Frontier + reconciliation window bookkeeping BEFORE the bound break, so an
      // all-older page still records a non-null frontier + oldest-seen.
      if (oldestSeenPublishedAt === null || post.publishedAt < oldestSeenPublishedAt) {
        oldestSeenPublishedAt = post.publishedAt;
      }

      await writeSnapshot({
        postId: post.id,
        subredditSlug: post.subredditSlug ?? (config.mode === "subreddit" ? channelKey : null),
        mediaType: post.mediaType,
        title: post.title,
        caption: post.selftext,
        permalink: post.permalink,
        thumbnailUrl: post.thumbnailUrl,
        publishedAt: post.publishedAt,
        author: post.author,
        authorFullname: post.authorFullname,
        metrics: { likes: post.metrics.likes, comments: post.metrics.comments },
        raw: post.raw,
        status: "ok",
      });
      seenIds.push(post.id);

      // Depth-window bound: the feed is newest-first, so stop the moment a post is
      // older than the target (deep) / already covered (incremental).
      if (post.publishedAt.getTime() < target.getTime()) {
        crossedBound = true;
        break;
      }
      collectedEvents.push(postToRawEvent(post));
      state.collected += 1;
      if (isDeep && state.collected >= maxPosts) {
        crossedBound = true;
        break;
      }
    }

    // Seed the subject entity from the page (minimal — Reddit exposes no profile
    // endpoint; the username/slug IS the immutable key). Best-effort.
    await seedSubject(config, channelKey, page.posts).catch((err) =>
      logger.warn(
        { jobId: job.id, channelKey, err: String((err as Error)?.message ?? err) },
        `${config.queue}: subject upsert failed (non-fatal)`,
      ),
    );

    state.cursor = page.nextCursor;
    if (page.endOfFeed || crossedBound || page.nextCursor === null) {
      state.complete = true;
      break;
    }
  }

  const pausedThisTick = pausedByBudget || pausedByRateLimit;

  // Empty first page on a brand-new source ⇒ probable bad/private handle → flag
  // needs_reconnect, do NOT mark complete (a typo would otherwise be swallowed).
  if (
    notFound ||
    (wasNeverPolled &&
      !pausedThisTick &&
      walkedThisTick &&
      fetchedThisTick === 0 &&
      requestsUsed > 0 &&
      state.complete)
  ) {
    for (const sub of subscribers) {
      await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
    }
    await markChannelLastPolledAt(config.kind, channelKey);
    if (triggerUserId) {
      await writeWalkAudit({ config, job, flow, channelKey, triggerUserId, requestsUsed, inserted: 0, branch });
    }
    logger.info(
      { jobId: job.id, channelKey },
      `${config.queue}: empty first page / not-found on new source — flagged needs_reconnect`,
    );
    return;
  }

  // ── Fan-out INSERT per subscriber ──
  const { insertedTotal, insertedByUser } = await fanOut(collectedEvents, subscribers, flow, triggerUserId);
  if (
    flow === "incremental" &&
    triggerUserId &&
    deepestWalked !== null &&
    oldestSeenPublishedAt !== null &&
    oldestSeenPublishedAt.getTime() < deepestWalked.getTime()
  ) {
    flow = "historical";
  }

  // ── Variant-A deletion reconciliation (12-SPIKE) ──
  // Only on a genuine COMPLETE coverage pass (unpaused; reached end-of-feed or the
  // branch bound). Scope to [oldestSeen, now] — the window we actually walked — so a
  // bounded incremental (K=2) never false-marks older-but-alive posts. A post absent
  // from this window that is tracked + not already flagged → set deletion_detected_at.
  const coveragePassComplete =
    !pausedThisTick && !notFound && walkedThisTick && state.complete && startedFromTop;
  let reconciledDeletions = 0;
  if (coveragePassComplete && seenIds.length > 0 && oldestSeenPublishedAt !== null) {
    reconciledDeletions = await reconcileDisappearances(
      config,
      channelKey,
      seenIds,
      oldestSeenPublishedAt,
    );
  }

  // ── Persist state + channel bookkeeping ──
  state.operatorPaused = pausedByBudget;
  const walkComplete = !pausedThisTick && state.complete;
  await writeRedditBackfillState(config.kind, channelKey, state);

  if (isDeep && oldestSeenPublishedAt !== null) {
    const frontier = oldestSeenPublishedAt;
    if (
      channelState?.backfillOldestAt == null ||
      frontier.getTime() < channelState.backfillOldestAt.getTime()
    ) {
      await markChannelBackfillFrontier(config.kind, channelKey, frontier);
    }
  }
  if (walkComplete) await markChannelBackfillComplete(config.kind, channelKey);
  await markChannelLastPolledAt(config.kind, channelKey);

  // A successful (unpaused, found) walk proves upstream healthy — clear reconnect.
  if (!pausedThisTick && !notFound) {
    for (const sub of subscribers) {
      await clearNeedsReconnect(sub.userId, sub.id).catch((err) =>
        logger.warn(
          { userId: sub.userId, sourceId: sub.id, err: String((err as Error)?.message ?? err) },
          `${config.queue}: clearNeedsReconnect failed`,
        ),
      );
    }
  }

  if (triggerUserId) {
    await writeWalkAudit({
      config,
      job,
      flow,
      channelKey,
      triggerUserId,
      requestsUsed,
      inserted: insertedByUser.get(triggerUserId) ?? 0,
      branch,
    });
  }

  logger.info(
    {
      jobId: job.id,
      channelKey,
      mode: config.mode,
      flow,
      triggerUserId: triggerUserId ?? null,
      subscribers: subscribers.length,
      candidates: collectedEvents.length,
      insertedTotal,
      requestsUsed,
      collected: state.collected,
      walkComplete,
      reconciledDeletions,
      pausedByBudget,
      pausedByRateLimit,
    },
    `${config.queue}: walk complete`,
  );
}

/** Seed the subject entity (account by username / subreddit by slug). Minimal —
 *  Reddit exposes no profile endpoint, so we anchor the immutable key row exists. */
async function seedSubject(
  config: RedditWalkConfig,
  channelKey: string,
  posts: NormalizedRedditPost[],
): Promise<void> {
  if (posts.length === 0) return;
  if (config.kind === "reddit_account") {
    await upsertRedditAccount({ username: channelKey });
  } else {
    await upsertRedditSubreddit({ slug: channelKey });
  }
}

/** Variant-A reconcile: mark tracked posts absent from the walked window as deleted.
 *  Scope = the subject (author=handle / subreddit_slug=handle) AND deletion not yet
 *  flagged AND within [oldestSeen, now] AND not in the seen set. */
async function reconcileDisappearances(
  config: RedditWalkConfig,
  channelKey: string,
  seenIds: string[],
  oldestSeen: Date,
): Promise<number> {
  // reddit_posts.author is stored VERBATIM (case-preserving, for display), but channelKey
  // is the lowercased handle (Reddit usernames are case-insensitive for lookup). Compare
  // case-insensitively or deletion detection silently never fires for a mixed-case author
  // (e.g. "GallowBoob"). subredditSlug is already lowercased on write (normalize.ts).
  const subjectFilter =
    config.kind === "reddit_account"
      ? sql`LOWER(${redditPosts.author}) = ${channelKey}`
      : eq(redditPosts.subredditSlug, channelKey);

  const updated = await db
    .update(redditPosts)
    .set({ deletionDetectedAt: sql`NOW()`, updatedAt: new Date() })
    .where(
      and(
        subjectFilter,
        isNull(redditPosts.deletionDetectedAt),
        isNotNull(redditPosts.publishedAt),
        gte(redditPosts.publishedAt, oldestSeen),
        notInArray(redditPosts.postId, seenIds),
      ),
    )
    .returning({ postId: redditPosts.postId });
  return updated.length;
}

async function fanOut(
  collectedEvents: RawEvent[],
  subscribers: Array<{ id: string; userId: string; autoImport: boolean; isOwnedByMe: boolean; backfillTargetSince: Date | null }>,
  flow: RedditWalkFlow,
  triggerUserId: string | undefined,
): Promise<{ insertedTotal: number; insertedByUser: Map<string, number> }> {
  let insertedTotal = 0;
  const insertedByUser = new Map<string, number>();
  if (collectedEvents.length === 0) return { insertedTotal, insertedByUser };

  const externalIds = collectedEvents.map((e) => e.externalId);
  const userIds = subscribers.map((s) => s.userId);
  const sourceIds = subscribers.map((s) => s.id);
  const existing = await db
    .select({ userId: events.userId, sourceId: events.sourceId, externalId: events.externalId })
    .from(events)
    .where(
      and(
        inArray(events.userId, userIds),
        inArray(events.sourceId, sourceIds),
        inArray(events.externalId, externalIds),
        sql`${events.kind} = 'reddit_post'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
      ),
    );
  const existingSet = new Set<string>();
  for (const r of existing) if (r.externalId) existingSet.add(`${r.userId}|${r.sourceId}|${r.externalId}`);

  for (const ev of collectedEvents) {
    for (const sub of subscribers) {
      if (sub.backfillTargetSince && ev.occurredAt < sub.backfillTargetSince) continue;
      const isTriggerUser = triggerUserId === sub.userId;
      if (flow === "auto_passive") {
        if (!sub.autoImport) continue;
      } else if (!isTriggerUser && !sub.autoImport) {
        continue;
      }
      if (existingSet.has(`${sub.userId}|${sub.id}|${ev.externalId}`)) continue;

      const inserted = await db
        .insert(events)
        .values({
          userId: sub.userId,
          sourceId: sub.id,
          kind: "reddit_post",
          authorIsMe: sub.isOwnedByMe,
          occurredAt: ev.occurredAt,
          title: ev.title,
          url: ev.url,
          externalId: ev.externalId,
          metadata: ev.metadata ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length > 0) {
        insertedTotal += 1;
        insertedByUser.set(sub.userId, (insertedByUser.get(sub.userId) ?? 0) + 1);
      }
    }
  }
  return { insertedTotal, insertedByUser };
}

/** STRICT backfill audit — the per-user cap counter (getUserQuotaUsedToday) SUMs
 *  requests_used from this row. metadata.platform = the SOURCE KIND (QUOTA_PLATFORM
 *  = reddit_account | reddit_subreddit), NOT the social-budget label "reddit" — the
 *  per-user quota keyspace is per-kind (Phase 10 two-keyspace lesson). The budget
 *  reserve inside the HTTP seam already draws from platform="reddit". */
async function writeWalkAudit(args: {
  config: RedditWalkConfig;
  job: RedditWalkJob;
  flow: RedditWalkFlow;
  channelKey: string;
  triggerUserId: string;
  requestsUsed: number;
  inserted: number;
  branch: string;
}): Promise<void> {
  await writeAuditStrict({
    userId: args.triggerUserId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind: args.config.kind,
      platform: args.config.kind, // QUOTA_PLATFORM — the source kind, NOT "reddit"
      channel_key: args.channelKey,
      flow: args.flow,
      queue: args.config.queue,
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.inserted,
      since_branch: args.branch,
    },
  });
}

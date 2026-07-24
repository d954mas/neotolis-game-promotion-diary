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
//   - A LEGIT low-traffic source lands at ≤~2 credits/day (K=2 daily walk; the warm
//     per-post catch lane was DISABLED — no lookup-by-id endpoint, see poll-cron.ts).
//     A mistaken FIREHOSE source's hard ceiling is the inherited per-user
//     LIMIT_SOCIAL_REQUESTS_PER_DAY + the operator 80/95% budget throttle (the real
//     money stops).

import { and, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
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
import { AppError } from "$lib/server/services/errors.js";
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

/** Kind-qualified deletion-ownership key stored in reddit_posts.deletion_detected_by.
 *  A post is shared across authors + subreddits, and an author username and a
 *  subreddit slug can be the SAME string (u/foo vs r/foo), so the bare channelKey
 *  would COLLIDE: r/foo's clear-on-reappear could wipe the GDPR purge clock u/foo's
 *  walk set (and vice-versa). Namespacing by kind makes ownership unambiguous —
 *  mirrors feed-enrichment's `${kind}:${channelKey}` paused-key namespacing. */
function deletionSubjectKey(kind: RedditSourceKind, channelKey: string): string {
  return `${kind}:${channelKey}`;
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
    // ONLY the intrinsic, rename-proof subreddit slug (part of the canonical URL — the
    // safe denorm). media_type + thumbnail_url are MUTABLE values owned by reddit_posts
    // (a post can be edited, a thumbnail re-derived): copying them here would leave a
    // stale event-metadata copy that export/DTO could serve. feed-enrichment reads both
    // fresh from reddit_posts via JOIN at render time (AGENTS.md no-denorm P0).
    metadata: {
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
  const loadSubscribers = async () =>
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
    db
      .select()
      .from(dataSources)
      .where(
        and(
          eq(dataSources.kind, config.kind),
          eq(dataSources.channelId, channelKey),
          isNull(dataSources.deletedAt),
        ),
      );
  let subscribers = await loadSubscribers();
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

  const jobTarget = new Date(job.data.depthBoundIso);
  if (Number.isNaN(jobTarget.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      `${config.queue}: invalid depthBoundIso; skipping`,
    );
    return;
  }

  const maxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const state0 = readRedditBackfillState(channelState);
  const deepestWalked = channelState?.backfillOldestAt ?? null;

  // A deep backfill that PAUSED before completing (budget/rate) leaves deepTargetIso
  // set + collected < maxPosts. It must RESUME as deep to its ORIGINAL target — NOT be
  // flipped to incremental by a poll-cron tick's 14-day window (which would wipe the
  // cursor and strand the archive below the frontier). forceDeep + a fresh source with
  // no deep-in-progress still take the deep branch below.
  const deepResume =
    !state0.complete && state0.deepTargetIso !== null && state0.collected < maxPosts;

  let branch: "exhausted" | "incremental" | "deep";
  if (job.data.forceDeep === true) branch = "deep";
  else if (deepResume) branch = "deep";
  else if (channelState?.backfillComplete === true) {
    // A COMPLETE channel is exhausted for every flow EXCEPT a new subscriber's
    // `initial` walk whose target is DEEPER than the walked frontier (review fix):
    // trusting `exhausted` there silently discards the new tenant's history request.
    // Only `initial` re-opens — a manual "Pull new content" (flow incremental,
    // EPOCH_ISO target) must stay the cheap newest-first sweep, and the PATCH-widen
    // path re-opens via resetWalkerStateOnWidening + forceDeep.
    branch =
      flow === "initial" && deepestWalked !== null && jobTarget.getTime() < deepestWalked.getTime()
        ? "deep"
        : "exhausted";
  } else if (deepestWalked !== null && jobTarget.getTime() >= deepestWalked.getTime())
    branch = "incremental";
  else branch = "deep";

  const isDeep = branch === "deep";
  const pageCap = isDeep ? DEEP_PAGE_CAP : INCREMENTAL_PAGE_CAP;

  // A resumed deep walks to its PERSISTED target (set when the deep first started);
  // every other pass uses the job's target. Fan-out still filters imports per-subscriber
  // by backfill_target_since, so the depth bound is purely the cost/coverage boundary.
  const target =
    deepResume && state0.deepTargetIso !== null ? new Date(state0.deepTargetIso) : jobTarget;

  // Resumable single-feed state. Incremental/exhausted branches sweep from page 1
  // (cursor null, count reset, deep target cleared); deep resumes from the persisted
  // cursor and records the target it is walking to so a later pause resumes correctly.
  let state = state0;
  if (!isDeep) {
    state = {
      cursor: null,
      complete: false,
      collected: 0,
      operatorPaused: state0.operatorPaused,
      deepTargetIso: null,
    };
  } else {
    // A deep pass RE-OPENED on a COMPLETED sub-state (initial-deeper / forceDeep
    // without the widen hook's reset) must restart from the top with a fresh cursor
    // — otherwise the `state.complete` short-circuit below no-ops the whole pass.
    if (state0.complete) {
      state = {
        cursor: null,
        complete: false,
        collected: 0,
        operatorPaused: state0.operatorPaused,
        deepTargetIso: null,
      };
    }
    state.deepTargetIso = target.toISOString();
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
  let pausedByUserQuota = false;
  let notFound = false;
  let walkedThisTick = false;
  let fetchedThisTick = 0;
  let droppedThisTick = 0;
  let crossedBound = false;

  // Reserve the paid credit and write its per-user accounting row atomically before
  // HTTP. A provider error therefore still counts exactly once, while an accounting
  // failure rolls back the reservation and prevents the request from starting.
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
      const fetchOptions =
        triggerUserId === undefined
          ? ({ origin: "cron" } as const)
          : ({
              origin: "user",
              userAccounting: {
                requestsPerDay: env.LIMIT_SOCIAL_REQUESTS_PER_DAY,
                auditEntry: {
                  userId: triggerUserId,
                  action: "source.refresh_content_requested",
                  ipAddress: "0.0.0.0",
                  metadata: {
                    kind: config.kind,
                    platform: config.kind,
                    channel_key: channelKey,
                    flow,
                    queue: config.queue,
                    job_id: job.id ?? null,
                    requests_used: 1,
                    events_inserted: 0,
                    since_branch: branch,
                  },
                },
              },
            } as const);
      page = await fetchRedditFeedPage(config.mode, channelKey, state.cursor, fetchOptions);
    } catch (err) {
      if (err instanceof AppError && err.code === "requests_quota_exhausted") {
        pausedByUserQuota = true;
      } else if (err instanceof AdapterError) {
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
    droppedThisTick += page.droppedCount;

    // Subject-identity belt (review fix): the author walk is a broad
    // `search?query=author:<handle>` — a page may carry posts NOT by the walked
    // subject (fuzzy match / provider drift). An off-subject post must never be
    // cached under this walk or fan out into diaries as the subject's own content.
    // Dropped rows count as lossy coverage (droppedThisTick), which suppresses the
    // disappearance reconcile this tick — a mismatch is never deletion evidence.
    // Author mode is STRICT (the search endpoint is the fuzzy one); subreddit mode
    // drops only a PRESENT-but-different slug — the native subreddit feed is scoped
    // by construction and may omit the `subreddit` field (writeSnapshot below
    // backfills it from channelKey).
    const channelKeyLower = channelKey.toLowerCase();
    const subjectPosts = page.posts.filter((post) =>
      config.mode === "author"
        ? post.author !== null && post.author.toLowerCase() === channelKeyLower
        : post.subredditSlug === null || post.subredditSlug === channelKeyLower,
    );
    const offSubject = page.posts.length - subjectPosts.length;
    if (offSubject > 0) {
      droppedThisTick += offSubject;
      logger.warn(
        { jobId: job.id, channelKey, mode: config.mode, offSubject },
        `${config.queue}: dropped off-subject posts from provider page`,
      );
    }

    for (const post of subjectPosts) {
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
    await seedSubject(config, channelKey, subjectPosts).catch((err) =>
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

  const pausedThisTick = pausedByBudget || pausedByRateLimit || pausedByUserQuota;

  // RE-READ the subscriber set after the (potentially seconds-long) page walk
  // (review fix): a tenant whose createSource committed mid-walk had their initial
  // job deduped by the channel-scoped singleton — they must still ride THIS fan-out,
  // or they see nothing until the next daily cron. Narrows the dedupe race window
  // from the whole walk to milliseconds. (A mid-walk subscriber's DEEPER initial
  // target can still be lost to the dedupe — accepted, rare; the PATCH-widen path
  // re-opens the deep walk on demand.)
  subscribers = await loadSubscribers();
  const widenedSubscriber =
    state.complete && !pausedThisTick
      ? subscribers
          .filter(
            (subscriber) =>
              subscriber.backfillTargetSince !== null &&
              subscriber.backfillTargetSince.getTime() < target.getTime(),
          )
          .sort(
            (left, right) =>
              left.backfillTargetSince!.getTime() - right.backfillTargetSince!.getTime(),
          )[0]
      : undefined;

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
      await writeWalkAudit({
        config,
        job,
        flow,
        channelKey,
        triggerUserId,
        requestsUsed: 0,
        inserted: 0,
        branch,
      });
    }
    logger.info(
      { jobId: job.id, channelKey },
      `${config.queue}: empty first page / not-found on new source — flagged needs_reconnect`,
    );
    return;
  }

  // ── Fan-out INSERT per subscriber ──
  const { insertedTotal, insertedByUser } = await fanOut(
    collectedEvents,
    subscribers,
    flow,
    triggerUserId,
  );
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
  // Clear-on-reappear runs on EVERY tick that sighted posts (a live sighting is direct
  // evidence, no full coverage needed) — subject-scoped so it never touches another
  // walk's flag. Runs before the disappearance-set: they operate on disjoint id sets.
  let clearedReappearances = 0;
  if (seenIds.length > 0) {
    clearedReappearances = await clearReappearedDeletions(config.kind, channelKey, seenIds);
  }

  // A pass that DROPPED any post (mapPostsResilient minority-drop) is NOT lossless
  // coverage: a dropped-but-alive post is absent from seenIds and the disappearance
  // reconcile would false-flag it deleted → purge. Suppress reconcile on a lossy pass;
  // clearReappearedDeletions above stays safe (it only touches posts we DID see).
  const lossyPass = droppedThisTick > 0;
  const coveragePassComplete =
    !pausedThisTick &&
    !notFound &&
    walkedThisTick &&
    state.complete &&
    startedFromTop &&
    !lossyPass;
  let reconciledDeletions = 0;
  if (coveragePassComplete && seenIds.length > 0 && oldestSeenPublishedAt !== null) {
    reconciledDeletions = await reconcileDisappearances(
      config,
      channelKey,
      seenIds,
      oldestSeenPublishedAt,
    );
  } else if (coveragePassComplete && fetchedThisTick === 0 && !wasNeverPolled) {
    // AUTHORITATIVE EMPTY feed on an ESTABLISHED source: the subject deleted ALL its
    // posts (the feed is newest-first, so a complete empty page-1 = zero posts exist).
    // The windowed reconcile above can't fire (no oldestSeen), so the entire tracked
    // subject set must be reconciled — otherwise a mass author-deletion never sets the
    // GDPR clock on ANY row. A brand-new empty source (wasNeverPolled) already returned
    // via the needs_reconnect branch above (a typo, not a mass deletion).
    reconciledDeletions = await reconcileAllDisappeared(config, channelKey);
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
      requestsUsed: 0,
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
      clearedReappearances,
      pausedByBudget,
      pausedByRateLimit,
    },
    `${config.queue}: walk complete`,
  );

  if (widenedSubscriber !== undefined && widenedSubscriber.backfillTargetSince !== null) {
    await runRedditWalk(
      {
        id: job.id === undefined ? undefined : `${job.id}:widened-target`,
        data: {
          kind: config.kind,
          channelKey,
          triggerUserId: widenedSubscriber.userId,
          depthBoundIso: widenedSubscriber.backfillTargetSince.toISOString(),
          flow: "initial",
          forceDeep: true,
        },
      },
      config,
    );
  }
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
 *  flagged AND STRICTLY newer than oldestSeen AND not in the seen set. The bound is
 *  `gt` (not `gte`): a still-alive post sharing oldestSeen's exact publish SECOND that
 *  fell just past the maxPosts cut must not be false-flagged as deleted. */
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
    // deletion_detected_by = the KIND-QUALIFIED subject key ATTRIBUTES the flag to THIS
    // subject, so only this subject's own re-sighting may later clear it
    // (clearReappearedDeletions) — a different walk that still sees the post alive can
    // no longer clobber the clock, AND u/foo can't clear r/foo's clock (name collision).
    .set({
      deletionDetectedAt: sql`NOW()`,
      deletionDetectedBy: deletionSubjectKey(config.kind, channelKey),
      updatedAt: new Date(),
    })
    .where(
      and(
        subjectFilter,
        isNull(redditPosts.deletionDetectedAt),
        isNotNull(redditPosts.publishedAt),
        gt(redditPosts.publishedAt, oldestSeen),
        notInArray(redditPosts.postId, seenIds),
      ),
    )
    .returning({ postId: redditPosts.postId });
  return updated.length;
}

/** Full-subject reconcile for an AUTHORITATIVE EMPTY feed (the subject deleted ALL
 *  posts). No oldestSeen window exists, so mark EVERY tracked, not-yet-flagged post of
 *  the subject as deleted with the kind-qualified subject key. Only invoked on a
 *  complete, unpaused, lossless, empty pass over an established source (walk-core) —
 *  never on a brand-new source (that path flags needs_reconnect instead). */
async function reconcileAllDisappeared(
  config: RedditWalkConfig,
  channelKey: string,
): Promise<number> {
  const subjectFilter =
    config.kind === "reddit_account"
      ? sql`LOWER(${redditPosts.author}) = ${channelKey}`
      : eq(redditPosts.subredditSlug, channelKey);

  const updated = await db
    .update(redditPosts)
    .set({
      deletionDetectedAt: sql`NOW()`,
      deletionDetectedBy: deletionSubjectKey(config.kind, channelKey),
      updatedAt: new Date(),
    })
    .where(and(subjectFilter, isNull(redditPosts.deletionDetectedAt)))
    .returning({ postId: redditPosts.postId });
  return updated.length;
}

/** Clear-on-reappear (subject-scoped self-correction). Un-flags posts THIS subject
 *  previously flagged as deleted (deletion_detected_by = `${kind}:${channelKey}`) that
 *  were re-sighted ALIVE this tick (post_id in seenIds). Matching on the KIND-QUALIFIED
 *  deletion_detected_by — NOT a blanket ok-write — is the whole cross-walker fix: a
 *  subreddit walk seeing an author-deleted post still live in the sub feed carries a
 *  different subject key, so it can no longer wipe the author walk's 48h GDPR purge
 *  clock — and u/foo and r/foo no longer collide. Runs on ANY tick with sightings (a
 *  live re-sighting is direct evidence — no full-coverage needed). */
async function clearReappearedDeletions(
  kind: RedditSourceKind,
  channelKey: string,
  seenIds: string[],
): Promise<number> {
  const cleared = await db
    .update(redditPosts)
    .set({ deletionDetectedAt: null, deletionDetectedBy: null, updatedAt: new Date() })
    .where(
      and(
        eq(redditPosts.deletionDetectedBy, deletionSubjectKey(kind, channelKey)),
        inArray(redditPosts.postId, seenIds),
      ),
    )
    .returning({ postId: redditPosts.postId });
  return cleared.length;
}

async function fanOut(
  collectedEvents: RawEvent[],
  subscribers: Array<{
    id: string;
    userId: string;
    autoImport: boolean;
    isOwnedByMe: boolean;
    backfillTargetSince: Date | null;
  }>,
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
  for (const r of existing)
    if (r.externalId) existingSet.add(`${r.userId}|${r.sourceId}|${r.externalId}`);

  const detachedLegacy = await db
    .select({
      id: events.id,
      userId: events.userId,
      externalId: events.externalId,
    })
    .from(events)
    .where(
      and(
        inArray(events.userId, userIds),
        inArray(events.externalId, externalIds),
        sql`${events.kind} = 'reddit_post'`,
        isNull(events.sourceId),
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        sql`${events.metadata} @> '{"reddit_legacy_source_detached":true}'::jsonb`,
      ),
    );
  const detachedByUserAndExternalId = new Map(
    detachedLegacy.map((row) => [`${row.userId}|${row.externalId}`, row.id]),
  );

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

      const detachedId = detachedByUserAndExternalId.get(`${sub.userId}|${ev.externalId}`);
      if (detachedId !== undefined) {
        const reattached = await db
          .update(events)
          .set({
            sourceId: sub.id,
            metadata: sql`${events.metadata} - 'reddit_legacy_source_detached'`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(events.userId, sub.userId), eq(events.id, detachedId), isNull(events.sourceId)),
          )
          .returning({ id: events.id });
        if (reattached.length > 0) {
          existingSet.add(`${sub.userId}|${sub.id}|${ev.externalId}`);
          detachedByUserAndExternalId.delete(`${sub.userId}|${ev.externalId}`);
          continue;
        }
      }

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

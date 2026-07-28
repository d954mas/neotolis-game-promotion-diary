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
//   - DUPLICATE INTENTS ARE MERGED, not re-walked (coalescePendingIntents): the
//     channel-scoped singleton only DEFERS a conflicting job, so two tenants adding the
//     same channel (or manual+cron overlapping) used to cost two full paid passes. The
//     pass now settles the pending intents it already covers by re-running the fan-out
//     over the SAME in-memory pages — free — and leaves the ones it does not cover
//     (deeper archive request, paused/lossy pass) pending for a real walk.

import { and, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { outbox } from "$lib/server/db/schema/outbox.js";
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
import {
  readRedditBackfillState,
  writeRedditBackfillState,
  redditWalkSingletonKey,
} from "../backfill-state.js";
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
/** Consecutive complete-and-empty passes required before an empty feed is treated as
 *  "the subject deleted everything" and its whole cached history is flagged for GDPR
 *  purge. Two daily passes ⇒ a transient search-index outage self-heals before any
 *  irreversible write; a genuine mass deletion is still caught within ~a day, well
 *  inside the 48h purge grace that follows. */
const AUTHORITATIVE_EMPTY_PASSES = 2;
/** Established subjects need corroboration before a provider 404 becomes a reconnect
 * signal. The old Reddit adapter used the same three-strike protection. */
const FIRST_PAGE_NOT_FOUND_THRESHOLD = 3;

/** One collected post: the cross-source RawEvent plus the walk-local facts the
 *  fan-out needs but the RawEvent contract does not carry (the post author, which
 *  decides `author_is_me` per post — NOT per source). */
interface CollectedPost {
  event: RawEvent;
  /** reddit_posts.author VERBATIM (case-preserving); null when the feed omitted it. */
  author: string | null;
}

/** Map one NormalizedRedditPost → the cross-source RawEvent. Title = the post
 *  headline (falls back to the self-text body first line, then a date fallback).
 *
 *  `subredditSlug` is the EFFECTIVE slug the caller resolved (the post's own value,
 *  falling back to the walked channelKey on a subreddit walk) — the SAME value
 *  writeSnapshot persists. Passing it in rather than re-reading post.subredditSlug is
 *  the review fix: the native subreddit feed may omit `subreddit`, and the two call
 *  sites used to disagree (cache got the fallback, the event's metadata got null), so
 *  the card lost its `r/<sub>` line for exactly those posts. */
function postToRawEvent(post: NormalizedRedditPost, subredditSlug: string | null): RawEvent {
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
      subreddit: subredditSlug,
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
    // Only `initial` re-opens — a routine manual "Pull new content" arrives as flow
    // incremental (backfillSource labels a pull `initial` only when the channel was
    // never walked or this source wants deeper than the frontier) and stays the
    // cheap newest-first sweep; the PATCH-widen path re-opens via
    // resetWalkerStateOnWidening + forceDeep.
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
      // Cross-pass corroboration, NOT walk progress — a cursor reset must not
      // forget that the previous passes came back empty, nor which deep target was
      // already served (the once-per-target settle memory).
      emptyPasses: state0.emptyPasses,
      notFoundPasses: state0.notFoundPasses,
      servedDeepTargetIso: state0.servedDeepTargetIso,
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
        emptyPasses: state0.emptyPasses,
        notFoundPasses: state0.notFoundPasses,
        servedDeepTargetIso: state0.servedDeepTargetIso,
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

  const collected: CollectedPost[] = [];
  const seenIds: string[] = [];
  let oldestSeenPublishedAt: Date | null = null;
  let requestsUsed = 0;
  let pausedByBudget = false;
  let pausedByRateLimit = false;
  let pausedByUserQuota = false;
  let notFound = false;
  let notFoundAtPage = -1;
  let walkedThisTick = false;
  let fetchedThisTick = 0;
  // TWO drop classes with different consequences: a PARSE drop (malformed provider
  // row) means a subject post may have been silently lost from the import — an
  // archive intent must not be settled against such a pass. An OFF-SUBJECT drop
  // (broad-search fuzz) loses nothing the subject owns and is routine on the author
  // path. Both make coverage lossy for the disappearance reconcile.
  let parseDroppedThisTick = 0;
  let offSubjectDroppedThisTick = 0;
  let crossedBound = false;
  let feedExhausted = false;

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
          notFoundAtPage = pageNo;
        } else {
          // transient / permanent → dead-letter (retryLimit 0 by design — the daily
          // poll cron is the natural retry, see REDDIT_WALK_QUEUE_OPTIONS).
          throw err;
        }
      } else {
        throw err;
      }
      break;
    }

    requestsUsed += page.creditsUsed;
    fetchedThisTick += page.posts.length;
    parseDroppedThisTick += page.droppedCount;
    if (page.droppedCount > 0) {
      logger.warn(
        { jobId: job.id, channelKey, mode: config.mode, parseDropped: page.droppedCount },
        `${config.queue}: dropped malformed posts from provider page`,
      );
    }

    // Subject-identity belt (review fix): the author walk is a broad
    // `search?query=author:<handle>` — a page may carry posts NOT by the walked
    // subject (fuzzy match / provider drift). An off-subject post must never be
    // cached under this walk or fan out into diaries as the subject's own content.
    // Dropped rows count as lossy coverage (offSubjectDroppedThisTick), which suppresses the
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
      offSubjectDroppedThisTick += offSubject;
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

      // ONE effective slug for BOTH the cache row and the event metadata (review fix):
      // the native subreddit feed may omit `subreddit`, and the walked channelKey IS
      // the slug in that mode. The author feed cannot infer it, so it stays null there.
      const effectiveSubredditSlug =
        post.subredditSlug ?? (config.mode === "subreddit" ? channelKey : null);

      await writeSnapshot({
        postId: post.id,
        subredditSlug: effectiveSubredditSlug,
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
      collected.push({
        event: postToRawEvent(post, effectiveSubredditSlug),
        author: post.author,
      });
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
      // Distinguish "the feed ran out" from "we stopped at the depth bound". Only the
      // former means no target, however old, can yield another post (see the
      // widened-subscriber gate below). crossedBound excludes it because we broke out
      // of the post loop early: the rest of THIS page is older than the bound and is
      // exactly what a deeper subscriber still wants, cursor or no cursor.
      feedExhausted = !crossedBound && (page.endOfFeed || page.nextCursor === null);
      state.complete = true;
      break;
    }
  }

  const pausedThisTick = pausedByBudget || pausedByRateLimit || pausedByUserQuota;

  // PENDING INTENTS for this exact channel (review fix, read BEFORE the subscriber
  // re-read below — the ordering is load-bearing). enqueueViaOutbox writes the intent
  // row in the SAME transaction as the createSource/refresh mutation, so an intent
  // visible here has a COMMITTED subscriber row, and the re-read that follows is
  // guaranteed to see it. That makes the intent safe to COLLAPSE into this walk (see
  // coalescePendingIntents) instead of letting the forwarder replay it as a second
  // PAID walk of the same feed once this job finishes.
  const pendingIntents = await selectPendingIntents(config, channelKey);

  // RE-READ the subscriber set after the (potentially seconds-long) page walk
  // (review fix): a tenant whose createSource committed mid-walk had their initial
  // job deduped by the channel-scoped singleton — they must still ride THIS fan-out,
  // or they see nothing until the next daily cron. Narrows the dedupe race window
  // from the whole walk to milliseconds.
  subscribers = await loadSubscribers();
  // COVERAGE FRONTIER, not this pass's bound. Comparing a subscriber's target against
  // `target` alone re-fires the widened recursion on EVERY completed pass, forever:
  // poll-cron always bounds at now-14d while a default source carries
  // backfillTargetSince = now-30d, so `now-30d < now-14d` holds on every tick even
  // after the channel has been walked to now-400d. That re-walk imports nothing (every
  // insert is an onConflictDoNothing no-op) but bills up to DEEP_PAGE_CAP pages a day
  // to the subscriber's PERSONAL daily quota, starving their own Refresh-Now.
  // Recurse only when the subscriber wants strictly deeper than the oldest point this
  // channel has ever reached — the same predicate the branch decision uses above — and
  // only while the feed still has pages left to give.
  const walkedFrontier =
    oldestSeenPublishedAt !== null &&
    (deepestWalked === null || oldestSeenPublishedAt.getTime() < deepestWalked.getTime())
      ? oldestSeenPublishedAt
      : deepestWalked;
  const coverageFrontier =
    walkedFrontier !== null && walkedFrontier.getTime() < target.getTime()
      ? walkedFrontier
      : target;
  // The once-per-target settle memory (servedDeepTargetIso): a target a completed
  // deep pass already walked FOR is settled even when the frontier never reached it
  // (feed bottom above the target, or the SOCIAL_BACKFILL_MAX_POSTS cap) — re-firing
  // the recursion for it re-pays the same capped pages daily, forever, importing
  // nothing. A failed/paused deep pass never records it, so recovery re-fires.
  const servedDeepTarget =
    state.servedDeepTargetIso === null ? null : new Date(state.servedDeepTargetIso);
  const widenedSubscriber =
    state.complete && !pausedThisTick && !feedExhausted
      ? subscribers
          .filter(
            (subscriber) =>
              subscriber.backfillTargetSince !== null &&
              subscriber.backfillTargetSince.getTime() < coverageFrontier.getTime() &&
              (servedDeepTarget === null ||
                subscriber.backfillTargetSince.getTime() < servedDeepTarget.getTime()),
          )
          .sort(
            (left, right) =>
              left.backfillTargetSince!.getTime() - right.backfillTargetSince!.getTime(),
          )[0]
      : undefined;

  // A first-page 404 on a never-polled source is a probable bad/private handle and can
  // be surfaced immediately. An ESTABLISHED source needs three consecutive misses:
  // one provider hiccup must not strand every subscriber behind needs_reconnect.
  //
  // Only a FIRST-PAGE 404 says anything about the subject. A 404 on page N>0 is a
  // provider hiccup mid-walk: bailing here would throw away the cursor and the posts
  // already paid for, and — worse — flag needs_reconnect on every subscriber, which
  // poll-cron filters out permanently (only a walk clears the flag, and cron will
  // never enqueue one again; Reddit has no credentials, so there is no "Reconnect"
  // affordance either). Fall through instead: the collected posts fan out, the cursor
  // persists, coveragePassComplete already excludes `notFound` so nothing reconciles,
  // and the next tick resumes where this one stopped.
  const firstPageNotFound = startedFromTop && notFound && notFoundAtPage === 0;
  if (firstPageNotFound) {
    state.notFoundPasses += 1;
    state.operatorPaused = false;
    await writeRedditBackfillState(config.kind, channelKey, state);
    const shouldFlag = wasNeverPolled || state.notFoundPasses >= FIRST_PAGE_NOT_FOUND_THRESHOLD;
    if (shouldFlag) {
      for (const sub of subscribers) {
        await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
      }
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
      { jobId: job.id, channelKey, notFoundPasses: state.notFoundPasses, shouldFlag },
      `${config.queue}: first-page not-found recorded`,
    );
    return;
  }

  // Any successful first page proves the subject endpoint is healthy, including a
  // later-page 404 where page one already returned usable posts.
  state.notFoundPasses = 0;

  if (
    wasNeverPolled &&
    !pausedThisTick &&
    walkedThisTick &&
    fetchedThisTick === 0 &&
    requestsUsed > 0 &&
    state.complete
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
      `${config.queue}: empty first page on new source — flagged needs_reconnect`,
    );
    return;
  }

  // Per-post author_is_me needs to know which Reddit usernames each subscriber CLAIMS
  // AS THEIR OWN — one lookup for the whole fan-out (see resolveOwnedUsernames).
  const ownedUsernames = await resolveOwnedUsernames(config, channelKey, subscribers);

  // ── Fan-out INSERT per subscriber ──
  const { insertedTotal, insertedByUser } = await fanOut(
    collected,
    subscribers,
    flow,
    triggerUserId,
    ownedUsernames,
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

  // ── Collapse the pending intents this walk already satisfied (review fix) ──
  // Each merged intent gets its OWN fan-out pass over the SAME in-memory page data —
  // pure DB work, ZERO extra provider requests — so a duplicate walk becomes free
  // instead of costing a second paid coverage pass. The intent's own flow +
  // triggerUserId are threaded so trigger-user semantics (a manual refresh landing on
  // an auto_import=false source) are preserved rather than silently dropped.
  const coalesced = await coalescePendingIntents({
    config,
    job,
    channelKey,
    pendingIntents,
    collected,
    subscribers,
    ownedUsernames,
    coveredTarget: widenedSubscriber?.backfillTargetSince ?? target,
    startedFromTop,
    walkedComplete: state.complete,
    paused: pausedThisTick || notFound,
    // PARSE drops only: a malformed row may BE a subject post this pass silently
    // lost, so an archive intent settled against it would drop history for good.
    // Off-subject drops lose nothing the subject owns (routine broad-search fuzz)
    // and must not block coalescing — that would resurrect the duplicate-paid-walk
    // problem on every fuzzy author page.
    lossy: parseDroppedThisTick > 0,
    branch,
  });

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
  const lossyPass = parseDroppedThisTick + offSubjectDroppedThisTick > 0;
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
  } else if (
    coveragePassComplete &&
    fetchedThisTick === 0 &&
    !wasNeverPolled &&
    state.emptyPasses + 1 >= AUTHORITATIVE_EMPTY_PASSES
  ) {
    // AUTHORITATIVE EMPTY feed on an ESTABLISHED source: the subject deleted ALL its
    // posts (the feed is newest-first, so a complete empty page-1 = zero posts exist).
    // The windowed reconcile above can't fire (no oldestSeen), so the entire tracked
    // subject set must be reconciled — otherwise a mass author-deletion never sets the
    // GDPR clock on ANY row. A brand-new empty source (wasNeverPolled) already returned
    // via the needs_reconnect branch above (a typo, not a mass deletion).
    //
    // Gated on AUTHORITATIVE_EMPTY_PASSES consecutive empty passes: the account path
    // reads Reddit's SEARCH INDEX, which goes empty for reasons that are not deletion
    // (see RedditBackfillState.emptyPasses). One bad day must not irreversibly strip
    // author + permalink data that other tenants also reference.
    reconciledDeletions = await reconcileAllDisappeared(config, channelKey);
  }

  // ── Persist state + channel bookkeeping ──
  // Corroboration counter for the branch above: a complete pass that saw nothing
  // increments it, ANY sighting resets it. Only counts passes that could have seen
  // posts — a paused / not-found / partial pass is not evidence either way.
  if (coveragePassComplete) {
    state.emptyPasses = fetchedThisTick === 0 ? state.emptyPasses + 1 : 0;
  }
  state.operatorPaused = pausedByBudget;
  const walkComplete = !pausedThisTick && state.complete;
  // Record the once-per-target settle memory: a COMPLETED deep pass walked FOR
  // `target`, so re-requesting a target at or above it can never advance the
  // frontier (the remaining gap is the feed bottom / the maxPosts cap, not missing
  // work). A strictly deeper NEW target still earns one fresh deep pass.
  if (isDeep && walkComplete) {
    if (servedDeepTarget === null || target.getTime() < servedDeepTarget.getTime()) {
      state.servedDeepTargetIso = target.toISOString();
    }
  }
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

  // Clearing needs_reconnect requires EVIDENCE the subject exists — at least one
  // fetched post (raw page-1 count, so a healthy-but-quiet source still clears: its
  // page 1 returns old posts). An EMPTY successful pass proves nothing: the author
  // search path answers a typo'd/private/empty subject with an empty 200 (never a
  // 404), so an unconditional clear here would un-flag it after the weekly rehab
  // pass and return it to daily paid polling forever — with no path that ever
  // re-flags it (markSourceNeedsReconnect needs a 404 or a never-polled channel).
  if (!pausedThisTick && !notFound && fetchedThisTick > 0) {
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
      candidates: collected.length,
      insertedTotal,
      coalescedIntents: coalesced,
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

interface WalkSubscriber {
  id: string;
  userId: string;
  autoImport: boolean;
  isOwnedByMe: boolean;
  backfillTargetSince: Date | null;
}

/** The lowercase Reddit usernames each subscriber claims as THEIR OWN, keyed by
 *  userId. Drives per-post `author_is_me` (see fanOut).
 *
 *  An ACCOUNT walk needs no query: the walked channelKey IS the author (the walk drops
 *  off-subject posts), so the source's own is_owned_by_me answers it.
 *
 *  A SUBREDDIT walk must NOT inherit the source flag (the review P1): r/gamedev's
 *  posts are written by thousands of strangers, and `is_owned_by_me` DEFAULTS TO TRUE
 *  on data_sources — so every imported community post was landing in the diary tagged
 *  "mine", poisoning the mine/others filter and the per-author counts. Ownership is a
 *  property of the POST's author, so we resolve it from the tenant's OWN reddit_account
 *  sources (the only place the user declares "this Reddit identity is mine") and match
 *  case-insensitively (Reddit usernames are case-insensitive; `author` is stored
 *  verbatim for display). No owned account ⇒ nothing in this subreddit is "mine". */
async function resolveOwnedUsernames(
  config: RedditWalkConfig,
  channelKey: string,
  subscribers: WalkSubscriber[],
): Promise<Map<string, Set<string>>> {
  const owned = new Map<string, Set<string>>();
  if (subscribers.length === 0) return owned;

  if (config.kind === "reddit_account") {
    for (const sub of subscribers) {
      if (sub.isOwnedByMe) owned.set(sub.userId, new Set([channelKey.toLowerCase()]));
    }
    return owned;
  }

  const userIds = [...new Set(subscribers.map((sub) => sub.userId))];
  const rows = await db
    .select({
      userId: dataSources.userId,
      channelId: dataSources.channelId,
      metadata: dataSources.metadata,
    })
    .from(dataSources)
    .where(
      and(
        inArray(dataSources.userId, userIds),
        eq(dataSources.kind, "reddit_account"),
        eq(dataSources.isOwnedByMe, true),
        isNull(dataSources.deletedAt),
      ),
    );
  for (const row of rows) {
    const handle = row.channelId ?? (row.metadata as { handle?: unknown } | null)?.handle;
    if (typeof handle !== "string" || handle === "") continue;
    const set = owned.get(row.userId) ?? new Set<string>();
    set.add(handle.toLowerCase());
    owned.set(row.userId, set);
  }
  return owned;
}

async function fanOut(
  collected: CollectedPost[],
  subscribers: WalkSubscriber[],
  flow: RedditWalkFlow,
  triggerUserId: string | undefined,
  ownedUsernames: Map<string, Set<string>>,
): Promise<{ insertedTotal: number; insertedByUser: Map<string, number> }> {
  let insertedTotal = 0;
  const insertedByUser = new Map<string, number>();
  if (collected.length === 0) return { insertedTotal, insertedByUser };

  const externalIds = collected.map((c) => c.event.externalId);
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

  for (const { event: ev, author } of collected) {
    const authorKey = author === null ? null : author.toLowerCase();
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
          // PER-POST, never per-source: "mine" means THIS post's author is an identity
          // the tenant declared as their own (resolveOwnedUsernames). An unknown author
          // is never "mine".
          authorIsMe: authorKey !== null && ownedUsernames.get(sub.userId)?.has(authorKey) === true,
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

/** A queue intent for THIS channel that the forwarder has not delivered yet — either
 *  because pg-boss refused it on the channel-scoped singleton (this very walk holds the
 *  key) or because it landed while we were walking. */
interface PendingWalkIntent {
  id: string;
  payload: Record<string, unknown>;
}

/** Pending intents for this (queue, channel). Read BEFORE the post-walk subscriber
 *  re-read so every intent seen here has an already-committed subscriber row
 *  (enqueueViaOutbox writes the intent inside the mutation's transaction). */
async function selectPendingIntents(
  config: RedditWalkConfig,
  channelKey: string,
): Promise<PendingWalkIntent[]> {
  const singletonKey = redditWalkSingletonKey(config.kind, channelKey);
  return db
    .select({ id: outbox.id, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.queue, config.queue),
        isNull(outbox.forwardedAt),
        sql`${outbox.options}->>'singletonKey' = ${singletonKey}`,
      ),
    );
}

/** Does THIS pass already deliver what the pending intent asked for? */
function intentCoveredByPass(
  payload: Record<string, unknown>,
  args: { coveredTarget: Date; walkedComplete: boolean; lossy: boolean },
): boolean {
  const flow = payload.flow;
  // A newest-first sweep (daily cron / manual "Pull new content"). The caller only
  // invokes this on a pass that STARTED AT THE TOP of the feed, which is exactly the
  // coverage such an intent wants — the page cap is irrelevant to it.
  if (flow === undefined || flow === "auto_passive" || flow === "incremental") return true;
  // An archive request (initial / historical, incl. forceDeep widen). Only collapse it
  // when this pass reached its coverage boundary LOSSLESSLY (a parse-lossy pass may
  // have silently dropped the very posts the archive request wants — leave the intent
  // pending so the forwarder replays it as a real walk) AND walked at least as deep as
  // the intent asks — otherwise the tenant's history request would be silently dropped.
  if (!args.walkedComplete || args.lossy) return false;
  if (typeof payload.depthBoundIso !== "string") return false;
  const depth = new Date(payload.depthBoundIso);
  if (Number.isNaN(depth.getTime())) return false;
  return depth.getTime() >= args.coveredTarget.getTime();
}

/**
 * MERGE the pending intents this walk already satisfied instead of letting the
 * forwarder replay them as additional PAID walks of the same feed (review P1).
 *
 * `retrySingletonConflict` alone never deduplicated anything: pg-boss refused the
 * duplicate send while this job was active, the outbox row stayed pending, and the very
 * next sweep re-sent it the moment this job completed — one extra full coverage pass per
 * duplicate intent, on a SHARED prepaid balance.
 *
 * Merging is free and lossless because the expensive half (the provider pages) is
 * already in memory: each merged intent gets its own fan-out over the same data with
 * ITS flow + trigger user, so a mid-walk subscriber lands their events here, and a
 * manual refresh on an auto_import=false source still imports for its trigger user.
 * An intent this pass does NOT cover (deeper archive, or a paused/lossy pass) is left
 * pending on purpose — the forwarder delivers it later and it walks for real.
 */
async function coalescePendingIntents(args: {
  config: RedditWalkConfig;
  job: RedditWalkJob;
  channelKey: string;
  pendingIntents: PendingWalkIntent[];
  collected: CollectedPost[];
  subscribers: WalkSubscriber[];
  ownedUsernames: Map<string, Set<string>>;
  coveredTarget: Date;
  startedFromTop: boolean;
  walkedComplete: boolean;
  paused: boolean;
  /** This pass dropped malformed provider rows (parse drops) — its coverage cannot
   *  settle an archive intent. */
  lossy: boolean;
  branch: string;
}): Promise<number> {
  if (args.pendingIntents.length === 0) return 0;
  // A paused / not-found tick proves nothing about coverage, and a resumed deep tick
  // (cursor already set) never fetched the newest page — leave every intent pending.
  if (args.paused || !args.startedFromTop) return 0;

  const merged = args.pendingIntents.filter((intent) => intentCoveredByPass(intent.payload, args));
  if (merged.length === 0) return 0;

  for (const intent of merged) {
    const flow: RedditWalkFlow =
      typeof intent.payload.flow === "string"
        ? (intent.payload.flow as RedditWalkFlow)
        : "auto_passive";
    const intentTriggerUserId =
      typeof intent.payload.triggerUserId === "string" ? intent.payload.triggerUserId : undefined;
    const { insertedByUser } = await fanOut(
      args.collected,
      args.subscribers,
      flow,
      intentTriggerUserId,
      args.ownedUsernames,
    );
    if (intentTriggerUserId !== undefined) {
      // The merged intent's trigger user gets their cap-counter row with
      // requests_used=0: they spent NO provider request (that is the whole point), but
      // the diary still owes them the "your refresh landed N events" trail.
      await writeWalkAudit({
        config: args.config,
        job: args.job,
        flow,
        channelKey: args.channelKey,
        triggerUserId: intentTriggerUserId,
        requestsUsed: 0,
        inserted: insertedByUser.get(intentTriggerUserId) ?? 0,
        branch: args.branch,
        coalesced: true,
      });
    }
  }

  await db
    .update(outbox)
    .set({
      forwardedAt: new Date(),
      lastError: "coalesced into the active reddit walk (no second paid pass)",
    })
    .where(
      and(
        inArray(
          outbox.id,
          merged.map((intent) => intent.id),
        ),
        isNull(outbox.forwardedAt),
      ),
    );
  logger.info(
    { jobId: args.job.id, channelKey: args.channelKey, coalesced: merged.length },
    `${args.config.queue}: merged pending walk intents into this pass`,
  );
  return merged.length;
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
  /** This row belongs to an intent MERGED into another walk (coalescePendingIntents) —
   *  no provider request of its own. */
  coalesced?: boolean;
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
      coalesced: args.coalesced === true,
    },
  });
}

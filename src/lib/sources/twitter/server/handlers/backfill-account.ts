// twitter.backfill.account queue handler — the account-scoped resumable walker
// (clone of tiktok/server/handlers/backfill-account.ts, single-feed, twitterapi.io
// provider, + the D-04 keepForAccount filter).
//
// One walk-step per tick; fan-out INSERT to ALL active subscribers of the account.
//
// SINGLE-FEED (RESEARCH Pattern 4): `/twitter/user/last_tweets` returns one
// next_cursor (a STRING) + one has_next_page (a boolean — 11-SPIKE.md Q2),
// structurally identical to TikTok's single feed. ONE cursor loop;
// `backfill_complete` = the single feed exhausted (the normalizer's endOfFeed =
// !has_next_page || !next_cursor, or an empty page).
//
// D-04 FILTER (the central Twitter delta): the page-level normalizer does NOT filter
// (it has no account-id scope). The walker applies keepForAccount(tweet, accountId)
// — keep originals + quote tweets + self-reply threads (promo "1/ 2/ 3/" imports
// whole), drop retweets (someone else's content/metrics) + replies to OTHER
// accounts. The account id is the feed owner's stable numeric id (= the channelKey).
// includeReplies=true is passed by the provider so self-replies even surface.
//
// D-05: each kept tweet's snapshot stores the DERIVED shares (retweet+quote) AND the
// raw retweet/quote/bookmark components (tweetRawComponents off the same Tweet).
//
// Other divergences mirror TikTok (encoded here):
//   - channelKey = the resolved Twitter account_id (NEVER the user-pasted handle —
//     handles rename; account_id is intrinsic). Lives on data_sources.metadata.
//     accountId; the walker reads the handle from metadata.handle only as the
//     provider query param.
//   - ONE page per tick (BACK-02). The running collected-count is persisted across
//     ticks (BACK-01): the walk stops when collected >= SOCIAL_BACKFILL_MAX_POSTS OR
//     a tweet.publishedAt < the date window OR end-of-feed, whichever first — cost
//     is independent of archive size. (This single-page-per-tick cadence + the
//     singleton walk per account IS the QPS pacing on the backfill path — one
//     twitterapi.io page per tick, never a burst; the lane intervalMs paces the
//     refresh path.)
//   - Pitfall 4: a missing/private handle returns an empty first page on a
//     brand-new source → markSourceNeedsReconnect not_found; do NOT mark
//     backfill_complete (that would silently swallow a typo'd handle). The PRIMARY
//     missing-handle signal is resolveAccount's null-by-presence at create time
//     (11-SPIKE.md Q3); the empty-first-page heuristic is the fallback.
//   - Pitfall 5: the trigger user pays the per-user cap ONCE per user action;
//     continuation pages run on the CRON pool (triggerUserId omitted).
//   - BUDGET-02: each page reserves operator credits BEFORE the provider call
//     (inside the provider HTTP seam via ctx.origin). A null permit surfaces as an
//     AdapterError(operator-issue | rate-limited) here → stop this tick and persist
//     the cursor for resume (pausable/throttled). A 429 (per-account QPS ceiling)
//     ALSO surfaces as rate-limited → the same pause-and-resume path.
//   - The free feed owner object (author{} on every tweet) UPSERTs twitter_accounts
//     opportunistically — NO extra credit.

import { and, eq, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { logger } from "$lib/server/logger.js";
import { writeAuditStrict } from "$lib/server/audit.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { QUEUES } from "$lib/server/queues.js";
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
import { getSocialProvider, fetchTwitterFeedPageWithRaw } from "../provider/registry.js";
import { TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS } from "../http.js";
import { writeSnapshot, upsertTwitterAccount } from "../snapshots.js";
import { twitterAccounts } from "../schema/index.js";
import { readTwitterBackfillState, writeTwitterBackfillState } from "../backfill-state.js";
import { buildTwitterTitle, keepForAccount, tweetRawComponents } from "../normalize.js";
import { env } from "$lib/server/config/env.js";
import { AdapterError } from "$lib/sources/errors.js";
import type { RawEvent, SourceKind } from "$lib/sources/adapter.js";
import type { NormalizedPost } from "$lib/sources/social-provider.js";

type BackfillFlow = "initial" | "incremental" | "historical" | "auto_passive";

interface BackfillAccountJob {
  id?: string;
  data: {
    kind: SourceKind;
    /** The resolved Twitter account_id (the channelKey). */
    channelKey: string;
    /** UserId who triggered this walk. Undefined for cron — the trigger user pays
     *  the per-user cap; cron continuation pages run on the cron pool. */
    triggerUserId?: string;
    /** Walk depth target — earliest publishedAt to walk to. ISO 8601. */
    depthBoundIso: string;
    flow: BackfillFlow;
    /** Force a deep walk regardless of the branch derivation (set by
     *  resetWalkerStateOnWidening). */
    forceDeep?: boolean;
  };
}

const KIND = "twitter_account" as const;

/** Map a NormalizedPost → cross-source RawEvent. The D-09 title (caption first line,
 *  "Tweet · <date>" fallback) is the shared buildTwitterTitle (one spelling with the
 *  paste-preview path). The permalink falls back to the canonical status URL when the
 *  tweet carried no url. */
function postToRawEvent(post: NormalizedPost, handle: string | null): RawEvent {
  const fallbackUrl =
    handle !== null
      ? `https://x.com/${handle}/status/${post.id}`
      : `https://x.com/i/status/${post.id}`;
  return {
    externalId: post.id,
    url: post.permalink ?? fallbackUrl,
    title: buildTwitterTitle(post.caption, post.publishedAt),
    occurredAt: post.publishedAt,
    kind: "twitter_post",
    metadata: {
      media_type: post.kind,
      thumbnail_url: post.thumbnailUrl,
      caption: post.caption,
    },
  };
}

export async function handleBackfillAccount(job: BackfillAccountJob): Promise<void> {
  const { channelKey, triggerUserId } = job.data;
  const kind = job.data.kind;
  let flow: BackfillFlow = job.data.flow ?? "auto_passive";

  if (typeof channelKey !== "string" || typeof kind !== "string") {
    logger.warn(
      { jobId: job.id, payload: job.data },
      "twitter.backfill.account: malformed payload (missing kind/channelKey); skipping",
    );
    return;
  }
  if (kind !== KIND) {
    logger.warn({ jobId: job.id, kind }, "twitter.backfill.account: unsupported kind; skipping");
    return;
  }

  // 1. Active subscribers for this account. CROSS-TENANT BY DESIGN — the whole
  //    point of account-scoped polling (the channelKey is the account_id, stored on
  //    data_sources.channelId at create time).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, KIND),
        eq(dataSources.channelId, channelKey),
        isNull(dataSources.deletedAt),
      ),
    );
  if (subscribers.length === 0) {
    logger.info(
      { jobId: job.id, channelKey },
      "twitter.backfill.account: no active subscribers — account orphaned; skipping",
    );
    return;
  }

  // The provider query handle. Prefer the CURRENT scraped @handle on the subject
  // entity (twitter_accounts.username, UPSERTed from the feed owner on every poll —
  // the rename-resilient source of truth); fall back to the create-time
  // data_sources.metadata.handle only before the first poll has populated it.
  const handle = await resolveHandle(channelKey, subscribers);
  if (handle === null) {
    logger.warn(
      { jobId: job.id, channelKey },
      "twitter.backfill.account: no handle on any subscriber metadata; skipping",
    );
    return;
  }

  const provider = getSocialProvider("twitter");
  if (provider === null) {
    // SOC-05 graceful degrade — provider not configured. No-op (the cron lane should
    // not have enqueued this, but be defensive).
    logger.info(
      { jobId: job.id, channelKey },
      "twitter.backfill.account: provider not configured; degrading to no-op",
    );
    return;
  }

  // 2. Channel state + branch derivation (mirror TikTok/IG three-branch).
  const channelState = await getChannelState(KIND, channelKey);
  const wasNeverPolled = channelState === undefined || channelState.lastPolledAt === null;

  const target = new Date(job.data.depthBoundIso);
  if (Number.isNaN(target.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      "twitter.backfill.account: invalid depthBoundIso; skipping",
    );
    return;
  }
  const deepestWalked = channelState?.backfillOldestAt ?? null;
  let branch: "exhausted" | "incremental" | "deep";
  if (job.data.forceDeep === true) {
    branch = "deep";
  } else if (channelState?.backfillComplete === true) {
    branch = "exhausted";
  } else if (deepestWalked !== null && target.getTime() >= deepestWalked.getTime()) {
    branch = "incremental";
  } else {
    branch = "deep";
  }

  // Incremental/exhausted branches DO NOT walk deeper (BACK-03): they fetch page 1
  // only (cursor reset to null) to discover new tweets since the frontier, and the
  // date-window `since` is the frontier (newest known), not the historical target.
  // Deep / forceDeep resume from the persisted cursor and walk toward `target`.
  const incrementalBranch = branch !== "deep";
  const dateWindowSince = computeDateWindowSince(branch, target, deepestWalked);

  // Read (or reset) the resumable single-feed state. Incremental/exhausted branches
  // start at page 1 (cursor null) with the running count reset to 0.
  let state = readTwitterBackfillState(channelState);
  if (incrementalBranch) {
    state = {
      cursor: null,
      complete: false,
      collected: 0,
      // Carry the prior paused flag — a successful (unpaused) tick below clears it;
      // a re-paused tick re-sets it. Resetting to false here would flicker the badge
      // off mid-pause on every incremental sweep.
      operatorPaused: state.operatorPaused,
    };
  }

  const maxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const origin: "cron" | "user" = triggerUserId ? "user" : "cron";

  // 3. Walk ONE page this tick. Accumulate events + count; stop when the feed ends,
  //    when a tweet is past the date window, or when the post-count cap is hit (deep
  //    branch only — the cap bounds historical depth).
  const collectedEvents: RawEvent[] = [];
  let requestsUsed = 0;
  let oldestFetchedOccurredAt: Date | null = null;
  // A real operator/budget pause (prepaid balance depleted / daily cap). Sets the
  // sticky operator_paused badge; strands until the daily poll-cron resets the budget.
  let pausedByBudget = false;
  // A transient per-account QPS 429 — the limit clears in seconds, so this tick
  // re-enqueues a paced continuation rather than stranding. Kept SEPARATE from
  // pausedByBudget so a busy QPS slot is NOT mislabeled as operator-budget-exhausted.
  let pausedByRateLimit = false;
  let rateLimitRetryAfterMs = TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS;
  let walkedThisTick = false;
  // The RAW upstream page size (pre-D-04-filter). The Pitfall-4 not-found
  // heuristic keys on this, NOT on collectedEvents.length — D-04 can drop EVERY
  // tweet from a NON-empty page (e.g. a first page that is all retweets), which
  // is a valid populated handle, not a missing one. Only a genuinely empty
  // upstream page means "no such handle / no tweets".
  let fetchedThisTick = 0;

  if (!state.complete && !(branch === "deep" && state.collected >= maxPosts)) {
    walkedThisTick = true;
    let feedPage;
    try {
      // ONE provider page (the tree-local fetch that ALSO surfaces the raw tweets for
      // the D-04 filter + D-05 raw components). The credit reservation runs inside the
      // provider's HTTP seam (http.ts) when origin is set — a null permit OR a 429
      // (per-account QPS ceiling) throws AdapterError (operator-issue / rate-limited)
      // which we catch to pause + persist the cursor for resume.
      feedPage = await fetchTwitterFeedPageWithRaw(handle, state.cursor, origin);
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.category === "rate-limited") {
          // Transient QPS 429 — re-enqueue a paced continuation (see resume below).
          // Honor the seam's Retry-After, floored at the 0.2-QPS interval.
          logger.info(
            { jobId: job.id, channelKey, category: err.category },
            "twitter.backfill.account: QPS pause — persisting cursor for paced resume",
          );
          pausedByRateLimit = true;
          rateLimitRetryAfterMs = err.retryAfterMs ?? TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS;
        } else if (err.category === "operator-issue") {
          // Prepaid balance depleted / daily cap — the next reserve would be refused
          // too, so retrying in 5s is pointless. Strand for the daily poll-cron.
          logger.info(
            { jobId: job.id, channelKey, category: err.category },
            "twitter.backfill.account: operator-budget pause — persisting cursor",
          );
          pausedByBudget = true;
        } else if (err.category === "not-found") {
          // Missing/private handle (HTTP 404). Flag every subscriber's source so
          // resolveTier shows unavailable; do NOT mark complete.
          for (const sub of subscribers) {
            await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
          }
          await markChannelLastPolledAt(KIND, channelKey);
          logger.info(
            { jobId: job.id, channelKey },
            "twitter.backfill.account: 404 not_found — sources flagged unavailable",
          );
          return;
        } else {
          // transient / permanent → rethrow for pg-boss retry / dead-letter.
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (feedPage !== undefined) {
      const page = feedPage.page;
      const rawTweets = feedPage.rawTweets;
      requestsUsed += page.creditsUsed;
      fetchedThisTick += page.posts.length;

      // Opportunistically refresh the account subject entity (twitter_accounts) from
      // the FREE feed owner object the page already carries — NO extra credit. The
      // richer profile fields (name / follower_count) were set by the PAID create-time
      // resolve and are COALESCE-preserved; this cheap refresh keeps account_id + the
      // current @handle (+ avatar) fresh, appending a renamed handle to
      // handle_aliases. Anchor on the feed owner's id, falling back to the channelKey.
      // Best-effort: a failed write must not abort the walk.
      if (page.owner !== undefined && page.owner !== null) {
        const ownerAccountId = page.owner.accountId ?? channelKey;
        try {
          await upsertTwitterAccount({
            accountId: ownerAccountId,
            username: page.owner.username,
            avatarUrl: page.owner.avatarUrl,
          });
        } catch (err) {
          logger.warn(
            { jobId: job.id, channelKey, err: String((err as Error)?.message ?? err) },
            "twitter.backfill.account: twitter_accounts UPSERT from feed owner failed (non-fatal)",
          );
        }
      }

      // D-04 FILTER: the page-level normalizer kept every tweet (no account-id scope).
      // Apply keepForAccount HERE — the feed owner's id is the account id we filter by
      // (fall back to the channelKey). The raw Tweet objects needed for the filter +
      // the raw components ride alongside the NormalizedPost on the same provider page.
      const filterAccountId = page.owner?.accountId ?? channelKey;

      // Write each kept tweet's snapshot + cache row, then collect the RawEvent.
      // Date-window bound: collect tweets newer than the window boundary; stop the
      // moment we cross below it (the page is newest-first).
      let crossedWindow = false;
      for (let i = 0; i < page.posts.length; i++) {
        const post = page.posts[i]!;
        const rawTweet = rawTweets[i] ?? null;

        // D-04: drop retweets + foreign replies; keep originals/quotes/self-replies.
        // When the raw tweet is unavailable (shouldn't happen for the feed page), keep
        // it (fail-open — the page already passed the normalizer).
        if (rawTweet !== null && !keepForAccount(rawTweet, filterAccountId)) {
          continue;
        }

        await writeSnapshot({
          tweetId: post.id,
          accountId: channelKey,
          mediaType: post.kind,
          caption: post.caption,
          permalink: post.permalink,
          thumbnailUrl: post.thumbnailUrl,
          publishedAt: post.publishedAt,
          metrics: {
            views: post.metrics.views,
            likes: post.metrics.likes,
            comments: post.metrics.comments,
            shares: post.metrics.shares,
          },
          // D-05 raw components from the same Tweet (presence-mapped).
          rawComponents: rawTweet !== null ? tweetRawComponents(rawTweet) : null,
          status: "ok",
        });

        // Frontier = the oldest tweet this deep walk FETCHED (snapshot written above),
        // regardless of the window. Recorded BEFORE the out-of-window break so an
        // all-older first page still writes a non-null frontier (else a later widen
        // early-exits on null and the older history is stranded). The window check below
        // only governs whether the tweet becomes an in-window FEED event.
        if (oldestFetchedOccurredAt === null || post.publishedAt < oldestFetchedOccurredAt) {
          oldestFetchedOccurredAt = post.publishedAt;
        }

        if (post.publishedAt.getTime() < dateWindowSince.getTime()) {
          crossedWindow = true;
          break;
        }
        collectedEvents.push(postToRawEvent(post, handle));
        state.collected += 1;
        // Post-count cap (deep branch): stop collecting the moment we hit it.
        if (branch === "deep" && state.collected >= maxPosts) {
          crossedWindow = true;
          break;
        }
      }

      // Advance / complete the single feed.
      state.cursor = page.nextCursor;
      if (page.endOfFeed || crossedWindow || page.nextCursor === null) {
        state.complete = true;
      }
    }
  }

  // Either pause kind stops advancing / completing this tick (cursor persists, feed
  // not marked complete). A rate-limit pause additionally re-enqueues a paced resume.
  const pausedThisTick = pausedByBudget || pausedByRateLimit;

  // 4. Pitfall 4 — empty first page on a brand-new source = probable bad/private
  //    handle. An EMPTY UPSTREAM page (fetchedThisTick === 0), a request was made,
  //    the feed reports end-of-feed with no cursor on the very first poll →
  //    not_found, NOT complete. Keying on the RAW page size (not the post-D-04
  //    collectedEvents count) avoids a false not-found when a valid handle's first
  //    page is entirely filtered out by D-04 (e.g. all retweets / foreign replies).
  if (
    wasNeverPolled &&
    !pausedThisTick &&
    walkedThisTick &&
    fetchedThisTick === 0 &&
    requestsUsed > 0 &&
    state.complete &&
    state.cursor === null
  ) {
    for (const sub of subscribers) {
      await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
    }
    await markChannelLastPolledAt(KIND, channelKey);
    if (triggerUserId) {
      await writeBackfillAudit({
        job,
        flow,
        channelKey,
        triggerUserId,
        requestsUsed,
        eventsInserted: 0,
        sinceBranch: branch,
      });
    }
    logger.info(
      { jobId: job.id, channelKey },
      "twitter.backfill.account: empty first page on new source — flagged not_found (Pitfall 4)",
    );
    return;
  }

  // 5. Fan-out INSERT for each subscriber. Per (event × subscriber): skip if
  //    occurredAt < subscriber.target_since; auto_passive skips non-auto_import
  //    subscribers; user flows let the trigger user override their own opt-out.
  let insertedTotal = 0;
  const insertedByUser = new Map<string, number>();
  if (collectedEvents.length > 0) {
    // Historical-flow upgrade for user clicks (mirror TikTok/IG): if the walk reached
    // deeper than the prior frontier, the click is historical.
    if (
      flow === "incremental" &&
      triggerUserId &&
      deepestWalked !== null &&
      oldestFetchedOccurredAt !== null &&
      oldestFetchedOccurredAt.getTime() < deepestWalked.getTime()
    ) {
      flow = "historical";
    }

    // Bulk idempotency pre-check (one SELECT). CROSS-TENANT BY DESIGN — fan-out dedup
    // spans subscribers via inArray on userId/sourceId.
    const externalIds = collectedEvents.map((e) => e.externalId);
    const userIds = subscribers.map((s) => s.userId);
    const sourceIds = subscribers.map((s) => s.id);
    const existing = await db
      .select({
        userId: events.userId,
        sourceId: events.sourceId,
        externalId: events.externalId,
      })
      .from(events)
      .where(
        and(
          inArray(events.userId, userIds),
          inArray(events.sourceId, sourceIds),
          inArray(events.externalId, externalIds),
          sql`${events.kind} = 'twitter_post'`,
          isNotNull(events.externalId),
          isNull(events.deletedAt),
        ),
      );
    const existingSet = new Set<string>();
    for (const r of existing) {
      if (r.externalId) existingSet.add(`${r.userId}|${r.sourceId}|${r.externalId}`);
    }

    for (const ev of collectedEvents) {
      for (const sub of subscribers) {
        if (sub.backfillTargetSince && ev.occurredAt < sub.backfillTargetSince) continue;
        const isTriggerUser = triggerUserId === sub.userId;
        if (flow === "auto_passive") {
          if (!sub.autoImport) continue;
        } else if (!isTriggerUser && !sub.autoImport) {
          continue;
        }
        const dedupKey = `${sub.userId}|${sub.id}|${ev.externalId}`;
        if (existingSet.has(dedupKey)) continue;

        // sourceId set so the tweet lands in the inbox (zero attached games).
        // onConflictDoNothing — race-safe against parallel walks.
        const inserted = await db
          .insert(events)
          .values({
            userId: sub.userId,
            sourceId: sub.id,
            kind: "twitter_post",
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
  }

  // 6. Persist state. BUDGET-01 producer: the operator-budget-paused badge hint. SET
  //    ONLY on a real operator-issue pause (NOT a transient QPS slot wait — a busy 5s
  //    pacer slot is not budget exhaustion); CLEARED on any non-budget-paused tick.
  state.operatorPaused = pausedByBudget;

  // Account-level complete = the single feed exhausted AND not paused this tick.
  const accountComplete = !pausedThisTick && state.complete;

  // SELF-ENQUEUE the next page of a bounded DEEP backfill so a multi-page archive
  // completes promptly. The cursor write + the continuation commit ATOMICALLY via the
  // outbox in the SAME transaction (AGENTS.md atomic-dual-write). Incremental/exhausted
  // branches reset to page 1 each tick, so a deep continuation there would re-fetch
  // page 1 forever — gated to branch === "deep". A budget pause is excluded (the next
  // reserve would refuse too).
  const shouldContinue =
    branch === "deep" && !accountComplete && !pausedThisTick && state.collected < maxPosts;
  // A transient QPS 429 re-enqueues on ANY branch (an incremental retry stays
  // incremental, a deep resume stays deep — the payload re-derives the branch). It was
  // paced out BEFORE doing work, so there is always work to retry. Mutually exclusive
  // with shouldContinue (that requires !pausedThisTick ⟹ !pausedByRateLimit), so no
  // double-enqueue.
  const shouldResumeAfterRateLimit = pausedByRateLimit;
  // Pace consecutive deep-backfill pages ≥5s apart — the 0.2-QPS floor (a never-paid
  // twitterapi.io account is 1 req/5s). The rate-limit resume waits the honored
  // Retry-After, floored at the same interval.
  const NORMAL_CONTINUATION_DELAY_S = Math.ceil(TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS / 1000);
  const RATE_LIMIT_RESUME_DELAY_S = Math.ceil(
    Math.max(rateLimitRetryAfterMs, TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS) / 1000,
  );
  await db.transaction(async (tx) => {
    await writeTwitterBackfillState(channelKey, state, tx);
    if (shouldContinue || shouldResumeAfterRateLimit) {
      await enqueueViaOutbox(
        tx,
        QUEUES.TWITTER_BACKFILL_ACCOUNT,
        {
          kind: KIND,
          channelKey,
          // triggerUserId OMITTED — continuation pages run on the cron pool (Pitfall
          // 5: the trigger user pays the per-user cap ONCE on the first page;
          // subsequent pages free-ride).
          depthBoundIso: job.data.depthBoundIso,
          flow,
          forceDeep: job.data.forceDeep,
        },
        {
          singletonKey: `backfill-account-${channelKey}`,
          startAfter: shouldResumeAfterRateLimit
            ? RATE_LIMIT_RESUME_DELAY_S
            : NORMAL_CONTINUATION_DELAY_S,
        },
      );
    }
  });
  if (branch === "deep" && oldestFetchedOccurredAt !== null) {
    // Frontier = the oldest event this deep walk fetched. markChannelBackfillFrontier
    // WHERE-guards the deeper-only move, so a shallower write never rolls it back.
    const frontier = oldestFetchedOccurredAt;
    if (
      channelState?.backfillOldestAt == null ||
      frontier.getTime() < channelState.backfillOldestAt.getTime()
    ) {
      await markChannelBackfillFrontier(KIND, channelKey, frontier);
    }
  }

  if (accountComplete) {
    await markChannelBackfillComplete(KIND, channelKey);
  }
  await markChannelLastPolledAt(KIND, channelKey);

  // Successful walk proves upstream healthy — clear needs_reconnect on all subs.
  for (const sub of subscribers) {
    try {
      await clearNeedsReconnect(sub.userId, sub.id);
    } catch (err) {
      logger.warn(
        { userId: sub.userId, sourceId: sub.id, err: String((err as Error)?.message ?? err) },
        "twitter.backfill.account: clearNeedsReconnect failed",
      );
    }
  }

  // 7. Audit — only for the trigger user (Pitfall 5: trigger pays once). Cron
  //    continuation pages enqueue with triggerUserId omitted → no audit row.
  if (triggerUserId) {
    await writeBackfillAudit({
      job,
      flow,
      channelKey,
      triggerUserId,
      requestsUsed,
      eventsInserted: insertedByUser.get(triggerUserId) ?? 0,
      sinceBranch: branch,
    });
  }

  logger.info(
    {
      jobId: job.id,
      channelKey,
      flow,
      triggerUserId: triggerUserId ?? null,
      subscribers: subscribers.length,
      candidates: collectedEvents.length,
      insertedTotal,
      requestsUsed,
      collected: state.collected,
      accountComplete,
      pausedByBudget,
      pausedByRateLimit,
    },
    "twitter.backfill.account: tick complete",
  );
}

/** The provider query handle for an account_id. The @handle is RENAMEABLE upstream,
 *  so the create-time data_sources.metadata.handle is only a hint — it goes stale the
 *  moment the account renames. The rename-resilient truth is twitter_accounts.username
 *  (the subject entity, UPSERTed from the free feed owner object on every successful
 *  poll). Prefer it; fall back to the create-time metadata.handle only when the entity
 *  row is absent (first backfill, before any poll has populated it). */
async function resolveHandle(
  channelKey: string,
  subscribers: Array<{ metadata: unknown }>,
): Promise<string | null> {
  const [account] = await db
    .select({ username: twitterAccounts.username })
    .from(twitterAccounts)
    .where(eq(twitterAccounts.accountId, channelKey))
    .limit(1);
  if (typeof account?.username === "string" && account.username !== "") return account.username;

  for (const sub of subscribers) {
    const handle = (sub.metadata as { handle?: string } | null)?.handle;
    if (typeof handle === "string" && handle !== "") return handle;
  }
  return null;
}

/** Date-window boundary. Deep branch walks toward the historical target. The
 *  incremental/exhausted branches sweep only what is newer than the frontier
 *  (BACK-03 — never deeper). */
function computeDateWindowSince(
  branch: "exhausted" | "incremental" | "deep",
  target: Date,
  deepestWalked: Date | null,
): Date {
  if (branch === "deep") return target;
  if (deepestWalked !== null && deepestWalked.getTime() > target.getTime()) return deepestWalked;
  return target;
}

async function writeBackfillAudit(args: {
  job: BackfillAccountJob;
  flow: BackfillFlow;
  channelKey: string;
  triggerUserId: string;
  requestsUsed: number;
  eventsInserted: number;
  sinceBranch: "exhausted" | "incremental" | "deep";
}): Promise<void> {
  // STRICT — the per-user-cap counter (getUserQuotaUsedToday) sums requests_used from
  // this row; a swallowed insert silently undercounts user usage. The EXISTING
  // source.refresh_content_requested verb + flow/platform tags so the same
  // cross-source cap counter applies (Pitfall 5: trigger pays once).
  //
  // platform = the SOURCE KIND ("twitter_account"), NOT the social-budget label
  // "twitter" — this row feeds the USER-QUOTA keyspace (getUserQuotaUsedToday /
  // quota-read.ts loadQuotaPlatforms read by adapter.kind). IG/TikTok tag the twin
  // row "instagram_account"/"tiktok_account" for the same reason; "twitter" here
  // would make the quota banner read 0 forever (it queries by "twitter_account").
  await writeAuditStrict({
    userId: args.triggerUserId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind: KIND,
      platform: KIND,
      channel_key: args.channelKey,
      flow: args.flow,
      queue: "twitter.backfill.account",
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.eventsInserted,
      since_branch: args.sinceBranch,
    },
  });
}

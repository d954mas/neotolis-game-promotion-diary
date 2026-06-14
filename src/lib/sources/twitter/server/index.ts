// Twitter/X per-source server barrel (clone of tiktok/server/index.ts, single-feed
// + NO short-link + NO thumbnail proxy).
//
// Cross-source code (registry, worker entrypoints, scheduler) imports ONLY from
// here: it sees `twitterAdapter` (the SourceAdapter implementation). The internal
// modules (adapter, http, provider, schema, handlers, quota, observability, readers)
// wire together inside this folder.
//
// Per-kind queue topology:
//   twitter.backfill.account  (the account-scoped single-feed resumable walker)
//   twitter.poll.cron         (key=active daily 06:00 UTC / key=cold daily 5am PT / key=warm hourly)
//   twitter.quota_reset       (midnight PT — daily-cap reset, never the twitterapi.io
//                              prepaid balance)
//
// DELTAS vs TikTok:
//   - SECOND VENDOR (twitterapi.io, NOT ScrapeCreators / D-01) — its OWN prepaid
//     balance row (provider="twitterapi.io"), reached via the SHARED ledger keyed by
//     provider (D-02). SOCIAL_PLATFORM="twitter" is the budget/provider keyspace.
//   - SINGLE-FEED walker (one next_cursor / has_next_page) — handlers/backfill-account.ts.
//   - NO SHORT-LINK resolve (D-07 — t.co deferred; X share URLs are already full
//     x.com URLs; the canonicalizeOnCreate seam exists if a real need ever appears).
//   - NO THUMBNAIL PROXY (11-SPIKE.md Q6 — DOCS-ONLY): pbs.twimg.com is historically
//     permissive (no Cross-Origin-Resource-Policy: same-origin), so Twitter HOTLINKS
//     the cover directly (D-06/D-08 hotlink + onerror). There is NO registerRoutes —
//     unlike TikTok (whose CDN is ORB-blocked → a same-origin proxy). The Q6 browser
//     renderability test is owed at Plan 04 UAT; if it turns out CORP-blocked there a
//     proxy is added then (the seam mirrors TikTok's).
//   - +shareCount (the DERIVED retweet+quote sum, D-05) + the raw retweet/quote/
//     bookmark components threaded through writeSnapshot → enrichment → metric-series.

import type {
  AdapterContext,
  BackfillWindow,
  CanonicalizeInput,
  CanonicalizeResult,
  CreateContext,
  EventKind,
  EventPreviewMetadata,
  MinimalBoss,
  PollableSource,
  SourceAdapter,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { DbOrTx, Tx } from "$lib/server/db/client.js";
import { QUEUES } from "$lib/server/queues.js";
import { getBoss } from "$lib/server/queue-client.js";
import { db } from "$lib/server/db/client.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { getChannelState } from "$lib/server/services/channel-state.js";
import { backfillWindowToDate } from "$lib/server/services/data-sources.js";
import {
  enforceAdapterUserQuota,
  getUserQuotaUsedToday,
  nextPacificMidnight,
} from "$lib/server/services/quota.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { twitterAccountAdapterCore } from "./adapter.js";
import { twitterParseUrl, twitterParseSourceUrl } from "./url.js";
import { buildTwitterTitle } from "./normalize.js";
import { resetTwitterBackfillState } from "./backfill-state.js";
import { getSocialThrottleState } from "./quota.js";
import { getSocialProvider } from "./provider/registry.js";
import { writeSnapshot } from "./snapshots.js";
import { adapterRefreshQueue, twitterPosts } from "$lib/server/db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";
import { handleBackfillAccount } from "./handlers/backfill-account.js";
import { handleTwitterPollCron } from "./handlers/poll-cron.js";
import { handleTwitterQuotaReset } from "./handlers/quota-reset.js";
import { twitterRefreshQueueTick, TWITTER_REFRESH_SLOTS } from "./handlers/refresh-queue-tick.js";
import { TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS } from "./http.js";

const KIND = "twitter_account" as const;
const EPOCH_ISO = "1970-01-01T00:00:00Z";

// TWO platform keyspaces meet in this barrel — they are NOT interchangeable:
//
//   SOCIAL_PLATFORM ("twitter") — the SOCIAL-BUDGET keyspace. Keys the shared
//     prepaid-credit ledger (social_provider_spend.platform, reserveSocialCredits /
//     getSocialSpendToday / getSocialThrottleState args, the social.* operator audit
//     verbs' metadata.platform, observability getRecentAudit). IG uses "instagram",
//     TikTok "tiktok" here. The provider arg of getSocialProvider/fetchPosts/
//     fetchPostByUrl is this same SocialPlatform value. DO NOT change these to the
//     source kind.
//
//   QUOTA_PLATFORM (= KIND, "twitter_account") — the USER-QUOTA keyspace. Keys the
//     per-user fair-share cap counter: getUserQuotaUsedToday / enforceAdapterUserQuota
//     filter audit_log on metadata.platform = <source kind>, and the /sources +
//     /audit QuotaStatusBanner reads getUserQuotaUsedToday(userId, adapter.kind)
//     (quota-read.ts loadQuotaPlatforms). IG writes "instagram_account", TikTok
//     "tiktok_account" (their KIND) for these so the UI's per-kind read matches the
//     writers. Using "twitter" here would make the banner read 0 forever (it queries
//     by "twitter_account") and diverge from the canon every other adapter follows.
const SOCIAL_PLATFORM = "twitter";
const QUOTA_PLATFORM = KIND;

/** Resolve the depth-bound ISO for a backfill from a source's resolved target.
 *  backfillTargetSince is derived by createSource from backfillWindow (default 30d,
 *  D-10); when null (no historical pull) the walker still needs a floor — use the
 *  window default. The window→date mapping is the shared backfillWindowToDate (one
 *  spelling with createSource's backfill_target_since derivation; 'everything' maps
 *  to the 1970 epoch = EPOCH_ISO). */
function depthBoundIsoForWindow(window: BackfillWindow, targetSince: Date | null): string {
  return targetSince?.toISOString() ?? backfillWindowToDate(window).toISOString();
}

async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.TWITTER_BACKFILL_ACCOUNT);
  await boss.createQueue(QUEUES.TWITTER_POLL_CRON);
  await boss.createQueue(QUEUES.TWITTER_QUOTA_RESET);

  // batchSize=1 keeps the backfill stream single-flight per worker.
  await boss.work(QUEUES.TWITTER_BACKFILL_ACCOUNT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillAccount(
        job as {
          id?: string;
          data: {
            kind: "twitter_account";
            channelKey: string;
            triggerUserId?: string;
            depthBoundIso: string;
            flow: "initial" | "incremental" | "historical" | "auto_passive";
            forceDeep?: boolean;
          };
        },
      );
    }
  });

  // poll.cron — Active + Cold + Warm collapsed via the tier-tagged payload.
  await boss.work(QUEUES.TWITTER_POLL_CRON, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleTwitterPollCron(
        job as {
          id?: string;
          data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
        },
        boss,
      );
    }
  });

  await boss.work(QUEUES.TWITTER_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleTwitterQuotaReset(job as { id?: string; data: object });
    }
  });
}

async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — daily 06:00 UTC (mirrors TikTok/IG #70: one feed credit amortized
  // over the newest tweets; daily matches the daily wishlist-correlation cadence).
  // Tweets that roll off page-1 are topped up by the warm per-post lane (1×/day while
  // < TWITTER_WARM_WINDOW_DAYS old).
  await boss.schedule(QUEUES.TWITTER_POLL_CRON, "0 6 * * *", { tier: "active" }, { key: "active" });
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.TWITTER_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Warm per-post auto-refresh — hourly. The staleness gate (>26h, just over the
  // daily free-poll interval) means a tweet gets at most ~1 paid refresh/day; hourly
  // just picks it up promptly after it crosses the gate (skip-if-pending dedup
  // prevents pile-up).
  await boss.schedule(QUEUES.TWITTER_POLL_CRON, "0 * * * *", { tier: "warm" }, { key: "warm" });
  // Daily-cap reset — midnight Pacific (the social-provider daily-cap boundary; the
  // twitterapi.io prepaid balance is never touched).
  await boss.schedule(QUEUES.TWITTER_QUOTA_RESET, "0 0 * * *", {}, { tz: "America/Los_Angeles" });
}

/**
 * backfillSource — user-driven "Pull new content" / cron-driven initial-fetch.
 * Enqueues an account-level walk. The trigger user pays the per-user cap
 * (origin==="user"); subscribers free-ride on the channel-wide fan-out.
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const md = (source.metadata ?? {}) as { accountId?: string; backfillTargetSince?: string };
  const channelKey = md.accountId ?? source.id;
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.TWITTER_BACKFILL_ACCOUNT,
    {
      kind: KIND,
      channelKey,
      triggerUserId: ctx.origin === "user" ? source.userId : undefined,
      depthBoundIso: md.backfillTargetSince ?? EPOCH_ISO,
      flow: ctx.origin === "user" ? "incremental" : "auto_passive",
    },
    {
      singletonKey: `backfill-account-${channelKey}`,
      priority: ctx.origin === "user" ? 1 : 0,
    },
  );
  return { jobId, queue: QUEUES.TWITTER_BACKFILL_ACCOUNT };
}

/**
 * canonicalizeOnCreate — resolve the user-pasted handle → the stable Twitter
 * account_id (the channelKey, persisted on data_sources.metadata.accountId so the
 * walker never keys off the renamable handle). Throws AppError 422 when the handle is
 * unresolvable (missing/suspended) so a phantom source is never created (SOC-01).
 *
 * NO SHORT-LINK resolve (D-07 — t.co deferred). X URLs are already full x.com URLs;
 * twitterParseSourceUrl handles every accepted form (handle / @handle / scheme-less /
 * mobile.* — #73). The AdapterError→AppError category mapping mirrors TikTok
 * (twitter_handle_unresolvable / twitter_rate_limited / twitter_provider_unavailable /
 * twitter_unreachable codes).
 */
async function canonicalizeOnCreate(
  input: CanonicalizeInput,
  _ctx: CreateContext,
): Promise<CanonicalizeResult> {
  const parsed = twitterParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a Twitter/X profile URL (e.g. https://x.com/<handle>).",
      "twitter_handle_unresolvable",
      422,
      { handle_url: input.handleUrl },
    );
  }
  // resolveHandleToAccountId issues a provider request that can throw AdapterError on
  // 401/402/429/5xx. The route mapper only knows AppError / NotFoundError, so an
  // unmapped AdapterError here becomes an opaque 500. Map it to a typed AppError by
  // category (mirrors TikTok + the refresh-content / preview paths).
  let resolved: { accountId: string; displayName: string | null } | null;
  try {
    resolved = await twitterAccountAdapterCore.resolveHandleToAccountId(parsed.handle);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") {
        resolved = null;
      } else if (err.category === "rate-limited") {
        throw new AppError(
          "Twitter/X is rate-limited right now — try adding this account again shortly.",
          "twitter_rate_limited",
          429,
          { handle: parsed.handle },
        );
      } else if (err.category === "operator-issue" || err.category === "permanent") {
        throw new AppError(
          "Twitter/X import is temporarily unavailable.",
          "twitter_provider_unavailable",
          503,
          { handle: parsed.handle },
        );
      } else {
        throw new AppError(
          "Could not reach Twitter/X to resolve that handle — try again.",
          "twitter_unreachable",
          502,
          { handle: parsed.handle },
        );
      }
    } else {
      throw err;
    }
  }
  if (resolved === null) {
    throw new AppError(
      "Could not resolve that Twitter/X handle — it may be suspended, misspelled, or the provider is not configured.",
      "twitter_handle_unresolvable",
      422,
      { handle: parsed.handle },
    );
  }
  return {
    canonicalHandleUrl: `https://x.com/${parsed.handle}`,
    resolvedExternalId: resolved.accountId,
    // The display name resolveAccount already fetched (name / username) so
    // data_sources.display_name is the real account name, not the bare account_id.
    displayName: resolved.displayName,
    // Persist the create-time handle (+ resolved account_id) onto the source row's
    // metadata. The account-scoped walker keys off channelId=account_id (intrinsic,
    // survives a handle rename) but MUST have a @handle to call fetchPosts(?userName=…).
    // The @handle is a MUTABLE query hint, NOT a rename-proof value — it goes stale the
    // moment the account renames. The current username lives on twitter_accounts
    // (the subject entity, UPSERTed from the free feed owner on every poll); the walker
    // prefers that and falls back to this hint only before the first poll has populated
    // it (resolveHandle, backfill-account.ts). So this is NOT a denorm carve-out — it is
    // a best-effort seed for the very first fetch.
    metadata: { handle: parsed.handle, accountId: resolved.accountId },
  };
}

/**
 * onSourceCreated — enqueue the initial backfill on createSource (inside the
 * createSource transaction via the shared outbox). Only fires when autoImport. The
 * trigger user pays the per-user cap once (triggerUserId set → the page-1 walk's
 * audit row counts against the user's daily cap).
 */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow; tx: Tx },
): Promise<void> {
  if (!source.autoImport) return;
  const md = (source.metadata ?? {}) as { accountId?: string };
  const channelKey = md.accountId ?? source.channelId ?? source.id;
  await enqueueViaOutbox(
    opts.tx,
    QUEUES.TWITTER_BACKFILL_ACCOUNT,
    {
      kind: KIND,
      channelKey,
      triggerUserId: source.userId,
      depthBoundIso: depthBoundIsoForWindow(opts.backfillWindow, source.backfillTargetSince),
      flow: "initial",
    },
    { singletonKey: `source-${source.id}` },
  );
}

/**
 * resetWalkerStateOnWidening — when the user widens backfillTargetSince past the
 * channel frontier on a complete account, enforce the per-user cap then enqueue a
 * forceDeep historical walk (counts against the operator budget, BUDGET-02). The
 * trigger user pays; subscribers free-ride. Runs inside the updateSource tx.
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
  if (source.kind !== KIND) return;
  const md = (source.metadata ?? {}) as { accountId?: string };
  const channelKey = md.accountId ?? source.channelId;
  if (channelKey === null || channelKey === undefined) return;

  // Defend-in-depth: only act on a genuine widen.
  if (ctx.previousTarget !== null && ctx.newTarget.getTime() >= ctx.previousTarget.getTime()) {
    return;
  }
  const state = await getChannelState(KIND, channelKey);
  if (!state) return;
  if (state.backfillComplete !== true) return;
  if (state.backfillOldestAt === null) return;
  if (ctx.newTarget.getTime() >= state.backfillOldestAt.getTime()) return;

  // Per-user fair-share cap — a PATCH widen burns the same budget as a refresh-content
  // click; without this gate a user at their daily cap could sneak a deep walk through
  // the PATCH path.
  const cap = twitterAccountAdapterCore.observability.userQuotaCap;
  if (cap?.requestsPerDay !== undefined) {
    const used = await getUserQuotaUsedToday(ctx.triggerUserId, QUOTA_PLATFORM);
    const resetAt = nextPacificMidnight();
    const resetInSeconds = Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000));
    if (used.requests >= cap.requestsPerDay) {
      throw new AppError(
        `daily request quota exhausted: ${used.requests}/${cap.requestsPerDay}`,
        "requests_quota_exhausted",
        429,
        { cap: cap.requestsPerDay, used: used.requests, reset_in_seconds: resetInSeconds },
      );
    }
  }

  // Clear the resumable sub-state so the forceDeep walk re-enters page 1 and walks
  // toward the new (deeper) target.
  await resetTwitterBackfillState(channelKey, ctx.tx);

  await enqueueViaOutbox(
    ctx.tx,
    QUEUES.TWITTER_BACKFILL_ACCOUNT,
    {
      kind: KIND,
      channelKey,
      triggerUserId: ctx.triggerUserId,
      depthBoundIso: ctx.newTarget.toISOString(),
      flow: "historical",
      forceDeep: true,
    },
    { singletonKey: `force-deep-${channelKey}-${ctx.triggerUserId}-${ctx.newTarget.getTime()}` },
  );
}

/**
 * enqueueRefreshNow — the per-event Refresh-Now path. PER-POST: inserts ONE row into
 * the shared adapter_refresh_queue (queue_name "user_post"); the Twitter lane worker
 * fetches exactly that tweet via the single-tweet endpoint + writeSnapshot.
 *
 * INSERT via the passed `tx` (requestRefreshPoll calls this inside its tx) — no
 * boss.send outside the mutating transaction. The per-user cap is already enforced by
 * requestRefreshPoll before this runs.
 */
async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  const dbCtx = input.tx ?? db;
  const [inserted] = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: KIND,
      queueName: "user_post",
      type: "post_stats",
      payload: { event_id: input.eventId, post_id: input.externalId },
      userId: input.userId,
      priority: -10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    queue: adapterRefreshQueueLabel(KIND, "user_post"),
    jobId: inserted ? String(inserted.id) : null,
  };
}

/**
 * fetchEventPreviewMetadata — adapter wrapper for the Add Event "Fetch" button
 * (POST /api/events/preview-url). Mirrors TikTok's synchronous single-post preview:
 * ONE by-URL provider request (1 credit), cap-gated, then UPSERTs the twitter_posts
 * cache + a snapshot (incl the DERIVED shares) so the saved event renders fully in
 * /feed.
 *
 * NO SHORT-LINK resolve (D-07). The URL is parsed by twitterParseUrl (?s=/?t= tail
 * stripped by construction).
 *
 * Cap + budget order (mirrors TikTok):
 *   1. enforceAdapterUserQuota (QUOTA_PLATFORM="twitter_account") — the per-user
 *      social cap (USER-QUOTA keyspace, = the source kind, like TikTok's
 *      "tiktok_account").
 *   2. reserveSocialCredits (origin="user") inside provider.fetchPostByUrl — the
 *      operator prepaid budget gate (SOCIAL_PLATFORM="twitter", twitterapi.io's own
 *      balance row, D-02).
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const provider = getSocialProvider(SOCIAL_PLATFORM);
  if (provider === null) {
    return { kind: "unreachable", cause: "twitter_not_configured" };
  }

  const parsed = twitterParseUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_twitter_post" };
  }
  // The CANONICAL permalink (query tail stripped) computed by the parser. This is the
  // SAME key resolveCachedExternalId looks the tweet id up by — writeSnapshot MUST
  // store this, not the raw canonicalUrl (which may carry ?s=… on a share paste), or
  // the create-time cache lookup misses.
  const canonicalPermalink =
    (parsed.metadata as { permalink?: string } | undefined)?.permalink ?? canonicalUrl;

  // Per-user fair-share cap — runs BEFORE the fetch so a cap-exhausted user never
  // burns a credit they aren't allowed to consume. Throws AppError 429 which
  // enrichFromUrl soft-handles.
  await enforceAdapterUserQuota(db, twitterAdapter, ctx.userId, ctx.ipAddress, "post-refresh", {
    platform: QUOTA_PLATFORM,
  });

  let post;
  try {
    // origin="user" → reserveSocialCredits charges the user pool inside the HTTP seam.
    // A null permit → AdapterError(operator-issue / rate-limited).
    post = await provider.fetchPostByUrl(SOCIAL_PLATFORM, canonicalUrl, { origin: "user" });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      if (err.category === "operator-issue") {
        return { kind: "unreachable", cause: "twitter_not_configured" };
      }
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }

  // A null body (deleted/private tweet — the envelope had no tweet object).
  if (post === null) {
    return { kind: "unavailable" };
  }

  // UPSERT the public-data cache + snapshot (incl the DERIVED shares) so the saved
  // event renders fully in /feed (thumbnail + stats + media-type pill) — exactly like
  // the walker. The raw retweet/quote/bookmark components are NOT on the single-tweet
  // port type (NormalizedSinglePost), so this paste path stores the derived shares
  // (the charted metric); the walker (which has the full Tweet) is where the raw split
  // is persisted.
  await writeSnapshot({
    tweetId: post.id,
    accountId: post.ownerId,
    mediaType: post.kind,
    caption: post.caption,
    permalink: canonicalPermalink,
    thumbnailUrl: post.thumbnailUrl,
    publishedAt: post.publishedAt,
    metrics: {
      views: post.metrics.views,
      likes: post.metrics.likes,
      comments: post.metrics.comments,
      shares: post.metrics.shares,
    },
    status: "ok",
  });

  // Cap-counter audit row (mirrors TikTok). This is what
  // getUserQuotaUsedToday(userId, "twitter_account") SUMs (USER-QUOTA keyspace) —
  // without the QUOTA_PLATFORM tag the per-user cap reads 0 forever and the
  // enforceAdapterUserQuota gate above never fires on the SECOND paste. TikTok tags
  // this row "tiktok_account" (its KIND) for the same reason.
  await writeAudit({
    userId: ctx.userId,
    action: "event.poll_refreshed",
    ipAddress: ctx.ipAddress,
    metadata: {
      external_id: post.id,
      kind: "twitter_post",
      platform: QUOTA_PLATFORM,
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });

  const ownerUrl = post.ownerUsername !== null ? `https://x.com/${post.ownerUsername}` : "";

  return {
    kind: "ok",
    title: buildTwitterTitle(post.caption, post.publishedAt),
    authorName: post.ownerUsername ?? "",
    authorUrl: ownerUrl,
    occurredAt: post.publishedAt,
    thumbnailUrl: post.thumbnailUrl ?? undefined,
    // The tweet id is the canonical key for a twitter_post event — the walker,
    // writeSnapshot, twitter_posts cache, poll-state, metric-series, and refresh-now
    // all match twitter_posts.tweet_id == event.externalId. The URL-parsed externalId
    // is ALSO the tweet id (the id IS the /status/<id> slug), but we return post.id
    // explicitly to mirror TikTok's media-id contract.
    externalId: post.id,
  };
}

/**
 * resolveCachedExternalId — re-derive a twitter_post event's tweet id from OUR cache,
 * given the (canonical or raw) event URL. The single-tweet PREVIEW
 * (fetchEventPreviewMetadata) UPSERTed twitter_posts with permalink = the canonical
 * status URL and tweet_id = the id, so the create boundary looks the id up by
 * permalink instead of trusting the request body (#70 — a client could pair tweet A's
 * URL with tweet B's id; the body is untrusted). twitterParseUrl canonicalizes the URL
 * the SAME way the preview did. On a MISS fall back to the URL-INTRINSIC status id
 * (the tweet id IS the /status/<id> slug).
 */
async function resolveCachedExternalId(url: string): Promise<string | null> {
  const parsed = twitterParseUrl(url);
  const permalink = (parsed?.metadata as { permalink?: string } | undefined)?.permalink;
  if (typeof permalink !== "string") return null;
  const [row] = await db
    .select({ tweetId: twitterPosts.tweetId })
    .from(twitterPosts)
    .where(eq(twitterPosts.permalink, permalink))
    .orderBy(desc(twitterPosts.updatedAt))
    .limit(1);
  // On a cache HIT the canonical-permalink lookup wins (untrusted body — a client
  // could pair tweet A's URL with tweet B's id, #70). On a MISS (no prior preview)
  // fall back to the URL-INTRINSIC tweet id: the id IS the /<handle>/status/<id> URL
  // slug, so the URL itself is the authoritative key when our cache has nothing.
  return row?.tweetId ?? parsed?.externalId ?? null;
}

// NO registerRoutes: 11-SPIKE.md Q6 is DOCS-ONLY — pbs.twimg.com is historically
// permissive (no Cross-Origin-Resource-Policy: same-origin, unlike TikTok's CDN), so
// Twitter HOTLINKS the cover directly (D-06/D-08). There is no same-origin thumbnail
// proxy. The Q6 browser renderability test is owed at Plan 04 UAT; if pbs.twimg.com
// turns out CORP-blocked there, a proxy + registerRoutes is added then (the seam
// mirrors TikTok's). Do NOT pre-build it (D-08).

// twitterAdapter — composes the core (./adapter.ts) with the infrastructure-touching
// methods (registerQueues / scheduleCronTicks / backfillSource) and the create-time
// hooks (canonicalizeOnCreate / onSourceCreated / resetWalkerStateOnWidening /
// refreshQueue / fetchEventPreviewMetadata / resolveCachedExternalId). The
// `SourceAdapter & typeof core` annotation fails the build if any required contract
// method is missing from the spread — completeness check by construction.
export const twitterAdapter: SourceAdapter & typeof twitterAccountAdapterCore = {
  ...twitterAccountAdapterCore,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canonicalizeOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  fetchEventPreviewMetadata,
  resolveCachedExternalId,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "twitter_post",
    canRun: async () => {
      // Block when the provider is unconfigured: the lane worker's isEnabled gates OFF
      // when getSocialProvider is null, so an enqueued row would NEVER run — an orphan
      // pending row + a forever-spinning Refresh button. getSocialThrottleState reads
      // the budget, not provider-constructability, so it can't catch this.
      if (getSocialProvider(SOCIAL_PLATFORM) === null) {
        return { action: "skip", reason: "twitter not configured" };
      }
      const throttle = await getSocialThrottleState(SOCIAL_PLATFORM, "twitterapi.io");
      return throttle === "ninetyfive"
        ? { action: "skip", reason: "twitter budget at 95%" }
        : { action: "run" };
    },
    enqueue: enqueueRefreshNow,
  },
  // Per-post Refresh lane. The generic worker bootstrap auto-starts each declared
  // scheduledWorker; isEnabled gates it off when the provider is unconfigured
  // (self-host without Twitter) so the lane never ticks/throws.
  //
  // QPS PACING: intervalMs = TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS (env-tunable, default
  // 5000ms = 0.2-QPS never-paid floor) + the lane's maxBatchSize=1 serialize twitterapi.io
  // calls to ≤1 per interval (the Reddit-lane pacing pattern). A paid operator on 3 QPS
  // lowers the env var (e.g. 400ms ≈ 2.5 QPS).
  workQueue: {
    scheduledWorkers: [
      {
        name: "twitter.refresh",
        intervalMs: TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS,
        replicaPolicy: "parallel",
        readyMessage: `twitter refresh queue worker ready (${TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS}ms QPS pacing)`,
        disabledMessage: "twitter refresh queue worker disabled (provider unconfigured)",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: KIND,
          slots: TWITTER_REFRESH_SLOTS,
          fallthrough: TWITTER_REFRESH_SLOTS,
          batchScope: "global",
        },
        isEnabled: () => getSocialProvider(SOCIAL_PLATFORM) !== null,
        tick: twitterRefreshQueueTick,
      },
    ],
  },
};

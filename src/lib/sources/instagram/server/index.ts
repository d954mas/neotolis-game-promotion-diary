// Instagram per-source server barrel.
//
// Cross-source code (registry, worker entrypoints, scheduler) imports ONLY from
// here: it sees `instagramAdapter` (the SourceAdapter implementation). The
// internal modules (adapter, http, provider, schema, handlers, quota,
// observability, readers) wire together inside this folder.
//
// Per-kind queue topology:
//   instagram.backfill.account  (the account-scoped resumable walker)
//   instagram.poll.cron         (key=active 6h / key=cold daily 5am PT)
//   instagram.quota_reset       (midnight PT — daily-cap reset, never the
//                                prepaid balance)
//
// Active + Cold collapse into one instagram.poll.cron queue via
// boss.schedule({key}); the poll-cron handler reads job.data.tier and
// dispatches. Cross-source crons stay in src/scheduler/index.ts which iterates
// allAdapters.scheduleCronTicks — the IG adapter is picked up by the dedup'd
// allAdapters (single reference → appears once).

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
import { getUserQuotaUsedToday, nextPacificMidnight } from "$lib/server/services/quota.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { instagramAccountAdapterCore } from "./adapter.js";
import { instagramParseUrl, instagramParseSourceUrl } from "./url.js";
import { resetInstagramBackfillState } from "./backfill-state.js";
import { getSocialThrottleState } from "./quota.js";
import { getSocialProvider } from "./provider/registry.js";
import { writeSnapshot } from "./snapshots.js";
import { handleBackfillAccount } from "./handlers/backfill-account.js";
import { handleInstagramPollCron } from "./handlers/poll-cron.js";
import { handleInstagramQuotaReset } from "./handlers/quota-reset.js";

const KIND = "instagram_account" as const;
const EPOCH_ISO = "1970-01-01T00:00:00Z";

/** Resolve the depth-bound ISO for a backfill from a source's resolved
 *  target. backfillTargetSince is derived by createSource from backfillWindow
 *  (default 30d, D-10); when null (no historical pull) the walker still needs a
 *  floor — use the window default. */
function depthBoundIsoForWindow(window: BackfillWindow, targetSince: Date | null): string {
  if (targetSince !== null) return targetSince.toISOString();
  if (window === "everything") return EPOCH_ISO;
  const days =
    window === "1d" ? 1 : window === "7d" ? 7 : window === "30d" ? 30 : window === "90d" ? 90 : 365;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.INSTAGRAM_BACKFILL_ACCOUNT);
  await boss.createQueue(QUEUES.INSTAGRAM_POLL_CRON);
  await boss.createQueue(QUEUES.INSTAGRAM_QUOTA_RESET);

  // batchSize=1 keeps the backfill stream single-flight per worker. The
  // producer-side singletonKey by channelKey is a best-effort coalescing hint on
  // this standard-policy queue, NOT a hard cross-worker guard; duplicate events
  // are prevented by onConflictDoNothing on the insert.
  await boss.work(QUEUES.INSTAGRAM_BACKFILL_ACCOUNT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillAccount(
        job as {
          id?: string;
          data: {
            kind: "instagram_account";
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

  // poll.cron — Active + Cold collapsed via the tier-tagged payload. batchSize=2
  // allows the two tiers' ticks to drain without head-of-line blocking.
  await boss.work(QUEUES.INSTAGRAM_POLL_CRON, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleInstagramPollCron(
        job as { id?: string; data: { tier: "active" | "cold" } & Record<string, unknown> },
        boss,
      );
    }
  });

  await boss.work(QUEUES.INSTAGRAM_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleInstagramQuotaReset(job as { id?: string; data: object });
    }
  });
}

async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — every 6 hours UTC (matches YouTube's active cadence).
  await boss.schedule(
    QUEUES.INSTAGRAM_POLL_CRON,
    "0 */6 * * *",
    { tier: "active" },
    { key: "active" },
  );
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.INSTAGRAM_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Daily-cap reset — midnight Pacific (the social-provider daily-cap boundary;
  // the prepaid balance is never touched).
  await boss.schedule(QUEUES.INSTAGRAM_QUOTA_RESET, "0 0 * * *", {}, { tz: "America/Los_Angeles" });
}

/**
 * backfillSource — user-driven "Pull new content" / cron-driven initial-fetch.
 * Enqueues an account-level walk. singletonKey by channelKey best-effort
 * coalesces parallel triggers across users (it is a hint, not a hard guard on a
 * standard-policy queue — duplicate events are prevented by onConflictDoNothing
 * on the insert); priority puts user-initiated jobs ahead of cron walks. The
 * trigger user pays the per-user cap (origin==="user"); subscribers free-ride on
 * the channel-wide fan-out.
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const md = (source.metadata ?? {}) as { accountId?: string; backfillTargetSince?: string };
  const channelKey = md.accountId ?? source.id;
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
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
  return { jobId, queue: QUEUES.INSTAGRAM_BACKFILL_ACCOUNT };
}

/**
 * canonicalizeOnCreate — resolve the user-pasted handle → the stable IG
 * account_id (the channelKey, persisted on data_sources.metadata.accountId so
 * the walker never keys off the renamable handle). Throws AppError 422 when the
 * provider is not configured OR the handle is unresolvable (missing/private) so
 * a phantom source is never created (SOC-01; mirrors YouTube's canonicalize
 * throw).
 */
async function canonicalizeOnCreate(
  input: CanonicalizeInput,
  _ctx: CreateContext,
): Promise<CanonicalizeResult> {
  const parsed = instagramParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste an Instagram profile URL (e.g. https://www.instagram.com/<handle>/).",
      "instagram_handle_unresolvable",
      422,
      { handle_url: input.handleUrl },
    );
  }
  // resolveHandleToAccountId issues a provider request that can throw
  // AdapterError on 401/402/429/5xx (bad key, rate-limit, upstream outage). The
  // route mapper (_shared.ts mapErr) only knows AppError / NotFoundError, so an
  // unmapped AdapterError here becomes an opaque 500. Map it to a typed AppError
  // by category (SOURCE-REFERENCE §4.5 taxonomy; same category→code shape as the
  // refresh-content path + fetchEventPreviewMetadata). The unconfigured case is
  // already gated earlier in createSource (kind_not_configured); don't regress it.
  let resolved: { accountId: string; displayName: string | null } | null;
  try {
    resolved = await instagramAccountAdapterCore.resolveHandleToAccountId(parsed.handle);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") {
        // Treated identically to the null-resolve below — the handle is
        // missing/private/misspelled (422, no phantom source).
        resolved = null;
      } else if (err.category === "rate-limited") {
        throw new AppError(
          "Instagram is rate-limited right now — try adding this account again shortly.",
          "instagram_rate_limited",
          429,
          { handle: parsed.handle },
        );
      } else if (err.category === "operator-issue" || err.category === "permanent") {
        // Provider misconfigured / disabled / ToS-blocked from the operator's
        // side — the user can't fix it; surface a clean 503, not a 500.
        throw new AppError(
          "Instagram import is temporarily unavailable.",
          "instagram_provider_unavailable",
          503,
          { handle: parsed.handle },
        );
      } else {
        // transient — upstream 5xx / network blip. 502 so the UI offers a retry.
        throw new AppError(
          "Could not reach Instagram to resolve that handle — try again.",
          "instagram_unreachable",
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
      "Could not resolve that Instagram handle — it may be private, misspelled, or the provider is not configured.",
      "instagram_handle_unresolvable",
      422,
      { handle: parsed.handle },
    );
  }
  return {
    canonicalHandleUrl: `https://www.instagram.com/${parsed.handle}/`,
    resolvedExternalId: resolved.accountId,
    // Thread the display name resolveAccount already fetched (full_name /
    // username) so data_sources.display_name is the real account name, not the
    // bare account_id. createSource only applies it when the user didn't type
    // an explicit displayName. Mirrors how a renamable display name is read
    // from source-of-truth (AGENTS.md no-denorm); this is the create-time seed.
    displayName: resolved.displayName,
    // Persist the URL-intrinsic handle (and resolved account_id) onto the
    // source row's metadata at create time. The account-scoped backfill walker
    // keys off channelId=account_id (intrinsic, survives handle rename) but
    // MUST have the handle to call fetchPosts(?handle=…) — it reads it via
    // resolveHandle → metadata.handle. Without this, a source created through
    // createSource (vs a test seeding metadata directly) leaves metadata.handle
    // unset and the walker skips with "no handle … skipping" → empty feed.
    // The handle is the provider query key (URL-intrinsic, not a renameable
    // display value), so it is the safe-denorm carve-out — mirrors Reddit's
    // metadata.username/subreddit injection.
    metadata: { handle: parsed.handle, accountId: resolved.accountId },
  };
}

/**
 * onSourceCreated — enqueue the initial backfill on createSource (inside the
 * createSource transaction via the shared outbox). Only fires when autoImport.
 * The trigger user pays the per-user cap once (Pitfall 5: triggerUserId set →
 * the page-1 walk's audit row counts against the user's daily cap).
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
    QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
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
 * channel frontier on a complete account, enforce the per-user cap then enqueue
 * a forceDeep historical walk (counts against the operator budget, BUDGET-02 /
 * D-13). The trigger user pays; subscribers free-ride. Runs inside the
 * updateSource transaction.
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

  // Per-user fair-share cap — a PATCH widen burns the same budget as a
  // refresh-content click; without this gate a user at their daily cap could
  // sneak a deep walk through the PATCH path.
  const cap = instagramAccountAdapterCore.observability.userQuotaCap;
  if (cap?.requestsPerDay !== undefined) {
    const used = await getUserQuotaUsedToday(ctx.triggerUserId, KIND);
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

  // Clear the resumable sub-state so the forceDeep walk re-enters page 1 of each
  // feed and walks toward the new (deeper) target.
  await resetInstagramBackfillState(channelKey, ctx.tx);

  await enqueueViaOutbox(
    ctx.tx,
    QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
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
 * enqueueRefreshNow — the per-event Refresh-Now path. An IG post's fresh metrics
 * come from an account-level page-1 incremental walk (the walker re-polls every
 * post on the page via writeSnapshot). triggerUserId set → the user pays the
 * per-user cap.
 */
async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  // Resolve the post's account_id from the public-data cache so the walk targets
  // the right account. The post may not be cached yet (paste before first poll);
  // in that case the refresh is a no-op (the next cron tick picks it up).
  const { instagramPosts } = await import("$lib/server/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const dbCtx = input.tx ?? db;
  const [row] = await dbCtx
    .select({ account: instagramPosts.accountId })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, input.externalId))
    .limit(1);
  const channelKey = row?.account ?? null;
  if (channelKey === null) {
    logger.info(
      { eventId: input.eventId, externalId: input.externalId },
      "instagram.enqueueRefreshNow: post not cached yet — refresh deferred to next cron tick",
    );
    return { queue: QUEUES.INSTAGRAM_BACKFILL_ACCOUNT, jobId: null };
  }
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
    {
      kind: KIND,
      channelKey,
      triggerUserId: input.userId,
      depthBoundIso: EPOCH_ISO,
      flow: "incremental",
    },
    { singletonKey: `refresh-now-${channelKey}-${input.userId}`, priority: 1 },
  );
  return { queue: QUEUES.INSTAGRAM_BACKFILL_ACCOUNT, jobId };
}

/**
 * fetchEventPreviewMetadata — adapter wrapper for the Add Event "Fetch" button
 * (POST /api/events/preview-url). Mirrors Reddit's synchronous single-post
 * preview: ONE by-URL provider request (1 credit), cap-gated, then UPSERTs the
 * instagram_posts cache + a snapshot so the saved event renders fully in /feed.
 *
 * Cap + budget order is load-bearing (mirrors the refresh path):
 *   1. enforceAdapterUserQuota — the per-user 50/day social cap. Its counter is
 *      the audit_log SUM of event.poll_refreshed/stats_refresh rows, and that row
 *      is written below only AFTER a successful fetch, so the count reflects real
 *      spend (and the gate fires on the SECOND paste, not the first).
 *   2. reserveSocialCredits (origin="user") runs INSIDE instagramFetch — the
 *      operator prepaid budget gate.
 * Cap exhaustion → AppError 429 propagates (the caller decides surface vs
 * soft-degrade). Budget exhaustion → AdapterError, mapped below to "unreachable"
 * so the form degrades to a manual title. Provider not configured (SOC-05) →
 * unreachable.
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const provider = getSocialProvider("instagram");
  if (provider === null) {
    return { kind: "unreachable", cause: "instagram_not_configured" };
  }
  const parsed = instagramParseUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_instagram_post" };
  }

  // Per-user fair-share cap (50/day) — runs BEFORE the fetch so a cap-exhausted
  // user never burns a credit they aren't allowed to consume. Throws AppError
  // 429 (requests_quota_exhausted) which enrichFromUrl soft-handles.
  const { enforceAdapterUserQuota } = await import("$lib/server/services/quota.js");
  await enforceAdapterUserQuota(db, instagramAdapter, ctx.userId, ctx.ipAddress, "post-refresh", {
    platform: "instagram_account",
  });

  let post;
  try {
    // origin="user" → reserveSocialCredits charges the user pool inside the HTTP
    // seam. A null permit → AdapterError(operator-issue / rate-limited).
    // canonicalUrl is the `/p/` | `/reel/` permalink parseIngestUrl already
    // canonicalized — feed it to the provider (the reel-vs-`/p/` shape is the
    // single-post media_type discriminator).
    post = await provider.fetchPostByUrl("instagram", canonicalUrl, { origin: "user" });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      if (err.category === "operator-issue") {
        return { kind: "unreachable", cause: "instagram_not_configured" };
      }
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }

  // A null body (deleted/private post — the envelope had no media object).
  if (post === null) {
    return { kind: "unavailable" };
  }

  // Reel-as-`/p/` media_type reconciliation (P2-2). The single-post endpoint has
  // no product_type, so a reel shared via a `/p/<code>/` permalink (rather than
  // `/reel/<code>/`) is URL-classified "video" by the normalizer. If the account
  // walker already imported this same post and resolved it to "short" (it sees
  // product_type on the feed/reels endpoints), prefer that cached value over the
  // URL-derived one — one cache lookup, no schema change. RESIDUAL LIMIT: a
  // genuinely-new `/p/` reel with no cache row stays "video" (a hard limit of
  // the single-post endpoint — no product_type to disambiguate, no `/reel/` slug
  // in the URL); the next account-level poll corrects it.
  const { instagramPosts } = await import("$lib/server/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const [cached] = await db
    .select({ mediaType: instagramPosts.mediaType })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, post.id))
    .limit(1);
  const mediaType = cached?.mediaType === "short" ? "short" : post.kind;

  // UPSERT the public-data cache + snapshot so the saved event renders fully in
  // /feed (thumbnail + stats + media-type pill) — exactly like the walker does
  // per post. Failure here is fatal to the preview (the caller catches the
  // throw and degrades), but a successful fetch should not be silently dropped.
  await writeSnapshot({
    postId: post.id,
    accountId: post.ownerId,
    mediaType,
    caption: post.caption,
    permalink: canonicalUrl,
    thumbnailUrl: post.thumbnailUrl,
    publishedAt: post.publishedAt,
    metrics: {
      views: post.metrics.views,
      likes: post.metrics.likes,
      comments: post.metrics.comments,
    },
    status: "ok",
  });

  // Cap-counter audit row (mirrors Reddit's syncStats.fetch / YouTube's
  // stats_refresh). This is what getUserQuotaUsedToday(userId,
  // "instagram_account") SUMs — without it the per-user cap reads 0 forever and
  // the enforceAdapterUserQuota gate above never fires on the SECOND paste.
  await writeAudit({
    userId: ctx.userId,
    action: "event.poll_refreshed",
    ipAddress: ctx.ipAddress,
    metadata: {
      external_id: post.id,
      kind: "instagram_post",
      platform: "instagram_account",
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });

  const ownerUrl =
    post.ownerUsername !== null ? `https://www.instagram.com/${post.ownerUsername}/` : "";

  return {
    kind: "ok",
    title: buildPreviewTitle(post.caption, mediaType, post.publishedAt),
    authorName: post.ownerUsername ?? "",
    authorUrl: ownerUrl,
    occurredAt: post.publishedAt,
    thumbnailUrl: post.thumbnailUrl ?? undefined,
    // The MEDIA id is the canonical key for an instagram_post event — the
    // walker, writeSnapshot, instagram_posts cache, poll-state, metric-series,
    // and refresh-now all match instagram_posts.post_id == event.externalId.
    // The URL-parsed externalId is the SHORTCODE (part of the permalink), which
    // is NOT the media id, so the event must be saved with post.id to enrich.
    externalId: post.id,
  };
}

/** Title = caption's FIRST line (D-09), falling back to the
 *  "Instagram <mediaType> · <date>" shape the walker's buildTitle uses so a
 *  caption-less paste still produces a meaningful, non-empty title (which the
 *  Add Event form requires). */
function buildPreviewTitle(caption: string | null, mediaType: string, publishedAt: Date): string {
  const trimmed = caption?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    const firstLine = trimmed.split("\n", 1)[0]!.trim();
    if (firstLine !== "") return firstLine;
  }
  return `Instagram ${mediaType} · ${publishedAt.toISOString().slice(0, 10)}`;
}

// instagramAdapter — composes the polling core (./adapter.ts) with the
// infrastructure-touching methods (registerQueues / scheduleCronTicks /
// backfillSource) and the create-time hooks (canonicalizeOnCreate /
// onSourceCreated / resetWalkerStateOnWidening / refreshQueue /
// fetchEventPreviewMetadata). The `SourceAdapter & typeof core` annotation
// fails the build if any required contract method is missing from the spread —
// completeness check by construction.
export const instagramAdapter: SourceAdapter & typeof instagramAccountAdapterCore = {
  ...instagramAccountAdapterCore,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canonicalizeOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  fetchEventPreviewMetadata,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "instagram_post",
    canRun: async () => {
      const throttle = await getSocialThrottleState("instagram", "scrapecreators");
      return throttle === "ninetyfive"
        ? { action: "skip", reason: "instagram budget at 95%" }
        : { action: "run" };
    },
    enqueue: enqueueRefreshNow,
  },
};

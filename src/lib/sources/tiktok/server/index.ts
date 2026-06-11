// TikTok per-source server barrel (clone of instagram/server/index.ts, single-feed
// + short-link + NO thumbnail proxy).
//
// Cross-source code (registry, worker entrypoints, scheduler) imports ONLY from
// here: it sees `tiktokAdapter` (the SourceAdapter implementation). The internal
// modules (adapter, http, provider, schema, handlers, quota, observability,
// readers) wire together inside this folder.
//
// Per-kind queue topology:
//   tiktok.backfill.account  (the account-scoped single-feed resumable walker)
//   tiktok.poll.cron         (key=active 6h / key=cold daily 5am PT / key=warm hourly)
//   tiktok.quota_reset       (midnight PT — daily-cap reset, never the SHARED
//                             prepaid balance)
//
// DELTAS vs IG:
//   - SINGLE-FEED walker (one max_cursor / has_more) — handlers/backfill-account.ts.
//   - SHORT-LINK resolve (vm./vt. → canonical) in canonicalizeOnCreate +
//     fetchEventPreviewMetadata (the seam stays consistent even though a SOURCE URL
//     is a @handle, not a video).
//   - +shareCount threaded through writeSnapshot → enrichment → metric-series.
//   - NO thumbnail proxy / NO registerRoutes: 10-SPIKE.md left Q3 (cover
//     hotlink-vs-CORP) docs-only/unconfirmed (covers on tiktokcdn-us.com, signed +
//     expiring, .awebp preferred over .heic — NOT browser-tested). Per the plan's
//     Q3 default for an unconfirmed spike → hotlink the raw CDN cover + onerror
//     fallback (D-07/8-D-08); the proxy is OWED to Plan 05 UAT if the cover renders
//     blocked in a real <img>. So this barrel omits registerRoutes entirely.

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
import { tiktokAccountAdapterCore } from "./adapter.js";
import { tiktokParseUrl, tiktokParseSourceUrl } from "./url.js";
import { resolveTikTokShortLink } from "./short-link.js";
import { resetTikTokBackfillState } from "./backfill-state.js";
import { getSocialThrottleState } from "./quota.js";
import { getSocialProvider } from "./provider/registry.js";
import { writeSnapshot } from "./snapshots.js";
import { adapterRefreshQueue, tiktokPosts } from "$lib/server/db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";
import { handleBackfillAccount } from "./handlers/backfill-account.js";
import { handleTikTokPollCron } from "./handlers/poll-cron.js";
import { handleTikTokQuotaReset } from "./handlers/quota-reset.js";
import { tiktokRefreshQueueTick, TIKTOK_REFRESH_SLOTS } from "./handlers/refresh-queue-tick.js";

const KIND = "tiktok_account" as const;
const EPOCH_ISO = "1970-01-01T00:00:00Z";
const PLATFORM = "tiktok";

/** Resolve the depth-bound ISO for a backfill from a source's resolved target.
 *  backfillTargetSince is derived by createSource from backfillWindow (default 30d,
 *  D-10); when null (no historical pull) the walker still needs a floor — use the
 *  window default. */
function depthBoundIsoForWindow(window: BackfillWindow, targetSince: Date | null): string {
  if (targetSince !== null) return targetSince.toISOString();
  if (window === "everything") return EPOCH_ISO;
  const days =
    window === "1d" ? 1 : window === "7d" ? 7 : window === "30d" ? 30 : window === "90d" ? 90 : 365;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.TIKTOK_BACKFILL_ACCOUNT);
  await boss.createQueue(QUEUES.TIKTOK_POLL_CRON);
  await boss.createQueue(QUEUES.TIKTOK_QUOTA_RESET);

  // batchSize=1 keeps the backfill stream single-flight per worker.
  await boss.work(QUEUES.TIKTOK_BACKFILL_ACCOUNT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillAccount(
        job as {
          id?: string;
          data: {
            kind: "tiktok_account";
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
  await boss.work(QUEUES.TIKTOK_POLL_CRON, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleTikTokPollCron(
        job as {
          id?: string;
          data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
        },
        boss,
      );
    }
  });

  await boss.work(QUEUES.TIKTOK_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleTikTokQuotaReset(job as { id?: string; data: object });
    }
  });
}

async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — daily 06:00 UTC (mirrors IG #70: one feed credit amortized over
  // the newest posts; daily cuts the dominant recurring spend ~4× and matches the
  // daily wishlist-correlation cadence). Posts that roll off page-1 are topped up by
  // the warm per-post lane (1×/day while < TIKTOK_WARM_WINDOW_DAYS old).
  await boss.schedule(QUEUES.TIKTOK_POLL_CRON, "0 6 * * *", { tier: "active" }, { key: "active" });
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.TIKTOK_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Warm per-post auto-refresh — hourly. The staleness gate (>26h, just over the
  // daily free-poll interval) means a post gets at most ~1 paid refresh/day; hourly
  // just picks it up promptly after it crosses the gate (skip-if-pending dedup
  // prevents pile-up).
  await boss.schedule(QUEUES.TIKTOK_POLL_CRON, "0 * * * *", { tier: "warm" }, { key: "warm" });
  // Daily-cap reset — midnight Pacific (the social-provider daily-cap boundary; the
  // SHARED prepaid balance is never touched).
  await boss.schedule(QUEUES.TIKTOK_QUOTA_RESET, "0 0 * * *", {}, { tz: "America/Los_Angeles" });
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
    QUEUES.TIKTOK_BACKFILL_ACCOUNT,
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
  return { jobId, queue: QUEUES.TIKTOK_BACKFILL_ACCOUNT };
}

/**
 * canonicalizeOnCreate — resolve the user-pasted handle → the stable TikTok
 * account_id (the channelKey, persisted on data_sources.metadata.accountId so the
 * walker never keys off the renamable handle). Throws AppError 422 when the handle
 * is unresolvable (missing/private) so a phantom source is never created (SOC-01).
 *
 * SHORT-LINK: resolve vm./vt. FIRST (resolveTikTokShortLink). A SOURCE URL is a
 * @handle, not a video, so a short-link is mostly moot here — but we keep the seam
 * consistent with the preview path. The AdapterError→AppError category mapping
 * mirrors IG (tiktok_handle_unresolvable / tiktok_rate_limited /
 * tiktok_provider_unavailable / tiktok_unreachable codes).
 */
async function canonicalizeOnCreate(
  input: CanonicalizeInput,
  _ctx: CreateContext,
): Promise<CanonicalizeResult> {
  // Resolve a vm./vt. short link to its canonical tiktok.com URL first (the seam
  // stays consistent with the preview path; a non-short input passes through).
  let handleUrl = input.handleUrl;
  try {
    const resolved = await resolveTikTokShortLink(input.handleUrl);
    if (resolved !== null) handleUrl = resolved;
  } catch (err) {
    // A short-link resolve failure is transient (network) — surface a retryable 502
    // rather than a phantom create or an opaque 500.
    if (err instanceof AdapterError && err.category === "transient") {
      throw new AppError(
        "Could not reach TikTok to resolve that link — try again.",
        "tiktok_unreachable",
        502,
        { handle_url: input.handleUrl },
      );
    }
    throw err;
  }

  const parsed = tiktokParseSourceUrl(handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a TikTok profile URL (e.g. https://www.tiktok.com/@<handle>).",
      "tiktok_handle_unresolvable",
      422,
      { handle_url: input.handleUrl },
    );
  }
  // resolveHandleToAccountId issues a provider request that can throw AdapterError
  // on 401/402/429/5xx. The route mapper only knows AppError / NotFoundError, so an
  // unmapped AdapterError here becomes an opaque 500. Map it to a typed AppError by
  // category (mirrors IG + the refresh-content / preview paths).
  let resolved: { accountId: string; displayName: string | null } | null;
  try {
    resolved = await tiktokAccountAdapterCore.resolveHandleToAccountId(parsed.handle);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") {
        resolved = null;
      } else if (err.category === "rate-limited") {
        throw new AppError(
          "TikTok is rate-limited right now — try adding this account again shortly.",
          "tiktok_rate_limited",
          429,
          { handle: parsed.handle },
        );
      } else if (err.category === "operator-issue" || err.category === "permanent") {
        throw new AppError(
          "TikTok import is temporarily unavailable.",
          "tiktok_provider_unavailable",
          503,
          { handle: parsed.handle },
        );
      } else {
        throw new AppError(
          "Could not reach TikTok to resolve that handle — try again.",
          "tiktok_unreachable",
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
      "Could not resolve that TikTok handle — it may be private, misspelled, or the provider is not configured.",
      "tiktok_handle_unresolvable",
      422,
      { handle: parsed.handle },
    );
  }
  return {
    canonicalHandleUrl: `https://www.tiktok.com/@${parsed.handle}`,
    resolvedExternalId: resolved.accountId,
    // The display name resolveAccount already fetched (nickname / username) so
    // data_sources.display_name is the real account name, not the bare account_id.
    displayName: resolved.displayName,
    // Persist the URL-intrinsic handle (+ resolved account_id) onto the source row's
    // metadata at create time. The account-scoped walker keys off
    // channelId=account_id (intrinsic, survives handle rename) but MUST have the
    // handle to call fetchPosts(?handle=…) — it reads it via metadata.handle. The
    // handle is the provider query key (URL-intrinsic, not a renameable display
    // value), so it is the safe-denorm carve-out (AGENTS.md no-denorm).
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
    QUEUES.TIKTOK_BACKFILL_ACCOUNT,
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

  // Per-user fair-share cap — a PATCH widen burns the same budget as a
  // refresh-content click; without this gate a user at their daily cap could sneak
  // a deep walk through the PATCH path.
  const cap = tiktokAccountAdapterCore.observability.userQuotaCap;
  if (cap?.requestsPerDay !== undefined) {
    const used = await getUserQuotaUsedToday(ctx.triggerUserId, PLATFORM);
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
  await resetTikTokBackfillState(channelKey, ctx.tx);

  await enqueueViaOutbox(
    ctx.tx,
    QUEUES.TIKTOK_BACKFILL_ACCOUNT,
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
 * enqueueRefreshNow — the per-event Refresh-Now path. PER-POST: inserts ONE row
 * into the shared adapter_refresh_queue (queue_name "user_post"); the TikTok lane
 * worker fetches exactly that post via the single-video endpoint + writeSnapshot.
 *
 * INSERT via the passed `tx` (requestRefreshPoll calls this inside its tx) — no
 * boss.send outside the mutating transaction. The per-user cap is already enforced
 * by requestRefreshPoll before this runs.
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
 * (POST /api/events/preview-url). Mirrors IG's synchronous single-post preview: ONE
 * by-URL provider request (1 credit), cap-gated, then UPSERTs the tiktok_posts cache
 * + a snapshot (incl shares) so the saved event renders fully in /feed.
 *
 * SHORT-LINK: resolve vm./vt. FIRST so a shared short link previews the real video.
 *
 * Cap + budget order (mirrors IG):
 *   1. enforceAdapterUserQuota (platform="tiktok") — the per-user social cap.
 *   2. reserveSocialCredits (origin="user") inside provider.fetchPostByUrl — the
 *      operator prepaid budget gate (shared with IG, D-01).
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const provider = getSocialProvider("tiktok");
  if (provider === null) {
    return { kind: "unreachable", cause: "tiktok_not_configured" };
  }

  // Resolve a vm./vt. short link to its canonical /@handle/video/<id> URL first.
  // resolveTikTokShortLink returns the input UNCHANGED for a non-short URL, the
  // canonical URL for a short link, or null when a short link resolved off TikTok.
  let videoUrl: string;
  try {
    const resolved = await resolveTikTokShortLink(canonicalUrl);
    if (resolved === null) {
      // A short link that resolved off TikTok (dead / open-redirect) — not a video.
      return { kind: "unreachable", cause: "url_not_tiktok_post" };
    }
    videoUrl = resolved;
  } catch (err) {
    if (err instanceof AdapterError && err.category === "transient") {
      return { kind: "unreachable", cause: "tiktok_unreachable" };
    }
    throw err;
  }

  const parsed = tiktokParseUrl(videoUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_tiktok_post" };
  }
  // The CANONICAL permalink (query tail stripped) computed by the parser. This is
  // the SAME key resolveCachedExternalId looks the aweme id up by — writeSnapshot
  // MUST store this, not the raw videoUrl (which carries ?is_from_webapp=… on a
  // share paste, or a redirect Location), or the create-time cache lookup misses.
  const canonicalPermalink =
    (parsed.metadata as { permalink?: string } | undefined)?.permalink ?? videoUrl;

  // Per-user fair-share cap — runs BEFORE the fetch so a cap-exhausted user never
  // burns a credit they aren't allowed to consume. Throws AppError 429 which
  // enrichFromUrl soft-handles.
  const { enforceAdapterUserQuota } = await import("$lib/server/services/quota.js");
  await enforceAdapterUserQuota(db, tiktokAdapter, ctx.userId, ctx.ipAddress, "post-refresh", {
    platform: PLATFORM,
  });

  let post;
  try {
    // origin="user" → reserveSocialCredits charges the user pool inside the HTTP
    // seam. A null permit → AdapterError(operator-issue / rate-limited).
    post = await provider.fetchPostByUrl("tiktok", videoUrl, { origin: "user" });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      if (err.category === "operator-issue") {
        return { kind: "unreachable", cause: "tiktok_not_configured" };
      }
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }

  // A null body (deleted/private video — the envelope had no aweme object).
  if (post === null) {
    return { kind: "unavailable" };
  }

  // UPSERT the public-data cache + snapshot (incl shares) so the saved event renders
  // fully in /feed (thumbnail + stats + media-type pill) — exactly like the walker.
  await writeSnapshot({
    awemeId: post.id,
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

  // Cap-counter audit row (mirrors IG). This is what getUserQuotaUsedToday(userId,
  // "tiktok") SUMs — without it the per-user cap reads 0 forever and the
  // enforceAdapterUserQuota gate above never fires on the SECOND paste.
  await writeAudit({
    userId: ctx.userId,
    action: "event.poll_refreshed",
    ipAddress: ctx.ipAddress,
    metadata: {
      external_id: post.id,
      kind: "tiktok_post",
      platform: PLATFORM,
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });

  const ownerUrl =
    post.ownerUsername !== null ? `https://www.tiktok.com/@${post.ownerUsername}` : "";

  return {
    kind: "ok",
    title: buildPreviewTitle(post.caption, post.kind, post.publishedAt),
    authorName: post.ownerUsername ?? "",
    authorUrl: ownerUrl,
    occurredAt: post.publishedAt,
    thumbnailUrl: post.thumbnailUrl ?? undefined,
    // The aweme id is the canonical key for a tiktok_post event — the walker,
    // writeSnapshot, tiktok_posts cache, poll-state, metric-series, and refresh-now
    // all match tiktok_posts.aweme_id == event.externalId. The URL-parsed externalId
    // is ALSO the aweme id (TikTok's id IS the URL slug), but we return post.id
    // explicitly to mirror IG's media-id contract.
    externalId: post.id,
  };
}

/** Title = caption's FIRST line (D-09), falling back to the "TikTok <mediaType> ·
 *  <date>" shape so a caption-less paste still produces a meaningful, non-empty
 *  title (which the Add Event form requires). */
function buildPreviewTitle(caption: string | null, mediaType: string, publishedAt: Date): string {
  const trimmed = caption?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    const firstLine = trimmed.split("\n", 1)[0]!.trim();
    if (firstLine !== "") return firstLine;
  }
  return `TikTok ${mediaType} · ${publishedAt.toISOString().slice(0, 10)}`;
}

/**
 * resolveCachedExternalId — re-derive a tiktok_post event's aweme id from OUR cache,
 * given the (canonical or raw) event URL. The single-video PREVIEW
 * (fetchEventPreviewMetadata) UPSERTed tiktok_posts with permalink = the canonical
 * video URL and aweme_id = the id, so the create boundary looks the id up by
 * permalink instead of trusting the request body (#70 — a client could pair video
 * A's URL with video B's id; the body is untrusted). tiktokParseUrl canonicalizes
 * the URL the SAME way the preview did. null when no cache row exists → an honest
 * stats-less card.
 */
async function resolveCachedExternalId(url: string): Promise<string | null> {
  const parsed = tiktokParseUrl(url);
  const permalink = (parsed?.metadata as { permalink?: string } | undefined)?.permalink;
  if (typeof permalink !== "string") return null;
  const [row] = await db
    .select({ awemeId: tiktokPosts.awemeId })
    .from(tiktokPosts)
    .where(eq(tiktokPosts.permalink, permalink))
    .orderBy(desc(tiktokPosts.updatedAt))
    .limit(1);
  // On a cache HIT the canonical-permalink lookup wins (untrusted body — a client
  // could pair video A's URL with video B's id, #70). On a MISS (no prior preview)
  // fall back to the URL-INTRINSIC aweme id: TikTok's id IS the /@handle/video/<id>
  // URL slug (10-SPIKE), so the URL itself is the authoritative key when our cache
  // has nothing. Without this fallback a no-preview create discards the id entirely
  // and strands the event on a permanently-pending stats badge.
  return row?.awemeId ?? parsed?.externalId ?? null;
}

// tiktokAdapter — composes the core (./adapter.ts) with the infrastructure-touching
// methods (registerQueues / scheduleCronTicks / backfillSource) and the create-time
// hooks (canonicalizeOnCreate / onSourceCreated / resetWalkerStateOnWidening /
// refreshQueue / fetchEventPreviewMetadata / resolveCachedExternalId). The
// `SourceAdapter & typeof core` annotation fails the build if any required contract
// method is missing from the spread — completeness check by construction.
//
// NO registerRoutes: 10-SPIKE.md left Q3 (cover hotlink-vs-CORP) docs-only, so the
// plan defaults to hotlinking the raw CDN cover (+ onerror). A same-origin thumbnail
// proxy is OWED to Plan 05 UAT only if a real <img> shows the cover CORP-blocked.
export const tiktokAdapter: SourceAdapter & typeof tiktokAccountAdapterCore = {
  ...tiktokAccountAdapterCore,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canonicalizeOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  fetchEventPreviewMetadata,
  resolveCachedExternalId,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "tiktok_post",
    canRun: async () => {
      // Block when the provider is unconfigured: the lane worker's isEnabled gates
      // OFF when getSocialProvider is null, so an enqueued row would NEVER run — an
      // orphan pending row + a forever-spinning Refresh button. getSocialThrottleState
      // reads the budget, not provider-constructability, so it can't catch this.
      if (getSocialProvider("tiktok") === null) {
        return { action: "skip", reason: "tiktok not configured" };
      }
      const throttle = await getSocialThrottleState("tiktok", "scrapecreators");
      return throttle === "ninetyfive"
        ? { action: "skip", reason: "tiktok budget at 95%" }
        : { action: "run" };
    },
    enqueue: enqueueRefreshNow,
  },
  // Per-post Refresh lane. The generic worker bootstrap auto-starts each declared
  // scheduledWorker; isEnabled gates it off when the provider is unconfigured
  // (self-host without TikTok) so the lane never ticks/throws.
  workQueue: {
    scheduledWorkers: [
      {
        name: "tiktok.refresh",
        intervalMs: 1000,
        replicaPolicy: "parallel",
        readyMessage: "tiktok refresh queue worker ready",
        disabledMessage: "tiktok refresh queue worker disabled (provider unconfigured)",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: KIND,
          slots: TIKTOK_REFRESH_SLOTS,
          fallthrough: TIKTOK_REFRESH_SLOTS,
          batchScope: "global",
        },
        isEnabled: () => getSocialProvider("tiktok") !== null,
        tick: tiktokRefreshQueueTick,
      },
    ],
  },
};

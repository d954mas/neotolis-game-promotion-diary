// Reddit per-source server barrel (the 4th ScrapeCreators consumer, D-01). Composes
// the adapter core (./adapter.ts) with the infrastructure-touching methods
// (registerQueues / scheduleCronTicks / backfillSource) and the create-time hooks
// (canonicalizeOnCreate / onSourceCreated / fetchEventPreviewMetadata /
// resolveCachedExternalId / refreshQueue / workQueue).
//
// Cross-source code (registry, worker entrypoints, scheduler) imports ONLY from here:
// it sees `redditAdapter` (the SourceAdapter implementation). ONE object serves BOTH
// source kinds (reddit_account + reddit_subreddit) — the registry Map points both
// kinds at this object, and backfillSource dispatches on source.kind.
//
// Per-kind queue topology:
//   reddit.backfill.account     (the author-search resumable walker, D-02)
//   reddit.backfill.subreddit   (the native subreddit walker)
//   reddit.poll.cron            (key=active daily 06:00 UTC / key=cold daily / key=warm hourly)
//   reddit.quota_reset          (midnight PT — daily-cap reset, never the shared prepaid balance)
//   reddit.deletion_propagation (daily 05:00 UTC — the GDPR author purge, D-06/D-08)
//
// DELTAS vs Twitter:
//   - SHARED ScrapeCreators prepaid pool (D-01, provider="scrapecreators") — NOT a
//     private balance row. SOCIAL_PLATFORM="reddit" is the budget/provider keyspace.
//   - TWO walkers (author-search + native subreddit) sharing one walk core;
//     backfillSource branches on source.kind.
//   - PURE canonicalizeOnCreate — NO provider round-trip (Reddit's key IS the
//     immutable username/slug; lazy validation). A typo yields an empty first walk.
//   - +the carry-over deletion-propagation daily purge schedule.
//   - NO thumbnail proxy (Pitfall 5 — hotlink + onerror; image variant confirmed at
//     12-06 UAT).

import type {
  AdapterContext,
  BackfillWindow,
  CanonicalizeInput,
  CanonicalizeResult,
  CreateContext,
  EventKind,
  EventPreviewMetadata,
  MinimalBoss,
  NormalizeSourceInput,
  NormalizeSourceResult,
  PollableSource,
  SourceAdapter,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { DbOrTx, Tx } from "$lib/server/db/client.js";
import { QUEUES } from "$lib/server/queues.js";
import { getBoss } from "$lib/server/queue-client.js";
import { db } from "$lib/server/db/client.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { backfillWindowToDate } from "$lib/server/services/data-sources.js";
import { enforceAdapterUserQuota } from "$lib/server/services/quota.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { writeAudit } from "$lib/server/audit.js";
import { eq, desc } from "drizzle-orm";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { redditAccountAdapterCore } from "./adapter.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { buildRedditTitle } from "./normalize.js";
import { getSocialThrottleState } from "./quota.js";
import { getSocialProvider } from "./provider/registry.js";
import { writeSnapshot } from "./snapshots.js";
import { handleBackfillAccount } from "./handlers/backfill-account.js";
import { handleBackfillSubreddit } from "./handlers/backfill-subreddit.js";
import { handleRedditPollCron } from "./handlers/poll-cron.js";
import { handleRedditQuotaReset } from "./handlers/quota-reset.js";
import { handleDeletionPropagationCron } from "./handlers/deletion-propagation-cron.js";
import { redditRefreshQueueTick, REDDIT_REFRESH_SLOTS } from "./handlers/refresh-queue-tick.js";

const KIND = "reddit_account" as const;
const EPOCH_ISO = "1970-01-01T00:00:00Z";

// TWO platform keyspaces meet in this barrel — NOT interchangeable:
//
//   SOCIAL_PLATFORM ("reddit") — the SOCIAL-BUDGET keyspace. Keys the shared prepaid
//     ScrapeCreators ledger (reserveSocialCredits / getSocialThrottleState args, the
//     social.* operator audit metadata.platform, observability getRecentAudit). The
//     provider arg of getSocialProvider/fetchPostByUrl is this same value.
//
//   QUOTA_PLATFORM (= the SOURCE KIND) — the USER-QUOTA keyspace. Keys the per-user
//     fair-share cap counter (getUserQuotaUsedToday / enforceAdapterUserQuota filter
//     audit_log on metadata.platform = <source kind>). The two WALKERS tag their
//     backfill audit with their ACTUAL kind (reddit_account | reddit_subreddit) per
//     row; the paste-preview path below uses KIND ("reddit_account") = adapter.kind
//     (the banner reads getUserQuotaUsedToday(userId, adapter.kind)). Using "reddit"
//     here would make the banner read 0 forever (Phase 10 two-keyspace lesson).
const SOCIAL_PLATFORM = "reddit";
const QUOTA_PLATFORM = KIND;

function depthBoundIsoForWindow(window: BackfillWindow, targetSince: Date | null): string {
  return targetSince?.toISOString() ?? backfillWindowToDate(window).toISOString();
}

async function registerQueues(boss: MinimalBoss): Promise<void> {
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_ACCOUNT);
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_SUBREDDIT);
  await boss.createQueue(QUEUES.REDDIT_POLL_CRON);
  await boss.createQueue(QUEUES.REDDIT_QUOTA_RESET);
  await boss.createQueue(QUEUES.REDDIT_DELETION_PROPAGATION);

  await boss.work(QUEUES.REDDIT_BACKFILL_ACCOUNT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleBackfillAccount(job as never);
  });
  await boss.work(QUEUES.REDDIT_BACKFILL_SUBREDDIT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleBackfillSubreddit(job as never);
  });
  await boss.work(QUEUES.REDDIT_POLL_CRON, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handleRedditPollCron(
        job as {
          id?: string;
          data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
        },
        boss,
      );
    }
  });
  await boss.work(QUEUES.REDDIT_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleRedditQuotaReset(job as { id?: string; data: object });
  });
  await boss.work(QUEUES.REDDIT_DELETION_PROPAGATION, { batchSize: 1 }, async (_jobs) => {
    await handleDeletionPropagationCron();
  });
}

async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — daily 06:00 UTC (one feed credit amortized over the newest posts).
  await boss.schedule(QUEUES.REDDIT_POLL_CRON, "0 6 * * *", { tier: "active" }, { key: "active" });
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.REDDIT_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Warm per-post next-day catch — hourly (window=2 days; a post gets at most ~1 paid
  // catch if it fell off the daily walk — 12-SPIKE "no long-lived warm lane").
  await boss.schedule(QUEUES.REDDIT_POLL_CRON, "0 * * * *", { tier: "warm" }, { key: "warm" });
  // Daily-cap reset — midnight Pacific (never the shared prepaid balance).
  await boss.schedule(QUEUES.REDDIT_QUOTA_RESET, "0 0 * * *", {}, { tz: "America/Los_Angeles" });
  // ★ Deletion-propagation author purge — daily 05:00 UTC (D-06/D-08 GDPR control).
  await boss.schedule(QUEUES.REDDIT_DELETION_PROPAGATION, "0 5 * * *", {}, { key: "purge" });
}

/**
 * backfillSource — user-driven "Pull new content" / cron initial-fetch. Branches on
 * source.kind: reddit_subreddit → the native subreddit walker; else → the
 * author-search walker. The trigger user pays the per-user cap (origin==="user");
 * subscribers free-ride on the channel-wide fan-out.
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  // PollableSource carries no `kind`, so discriminate on the metadata canonicalize
  // persisted: a subreddit source has metadata.slug, an account source has
  // metadata.handle.
  const md = (source.metadata ?? {}) as { handle?: string; slug?: string };
  const isSubreddit = typeof md.slug === "string" && md.slug !== "";
  const kind = isSubreddit ? "reddit_subreddit" : "reddit_account";
  const channelKey = md.handle ?? md.slug ?? source.id;
  const queue = isSubreddit ? QUEUES.REDDIT_BACKFILL_SUBREDDIT : QUEUES.REDDIT_BACKFILL_ACCOUNT;
  const boss = await getBoss();
  const jobId = await boss.send(
    queue,
    {
      kind,
      channelKey,
      triggerUserId: ctx.origin === "user" ? source.userId : undefined,
      depthBoundIso: EPOCH_ISO,
      flow: ctx.origin === "user" ? "incremental" : "auto_passive",
    },
    {
      singletonKey: `reddit-backfill-${kind}-${channelKey}`,
      priority: ctx.origin === "user" ? 1 : 0,
    },
  );
  return { jobId, queue };
}

/**
 * normalizeSourceOnCreate — PURE local URL canonicalization + metadata injection that
 * runs BEFORE createSource's cheap exact-duplicate / quota pre-checks (adapter.ts
 * NormalizeSourceInput contract). Two jobs canonicalizeOnCreate — which runs AFTER the
 * pre-checks — structurally cannot do:
 *   1. www-normalize the pasted URL (reddit.com/u/X → https://www.reddit.com/user/X) so
 *      the exact handle_url duplicate pre-check compares apples to apples with the stored
 *      canonical URL. Without it a re-add's RAW handle_url misses the pre-check, then
 *      canonicalizeOnCreate resolves a non-null channelId and the re-add trips the generic
 *      channel-id 409 (assertNoChannelConflict) instead of the per-kind 422 duplicate_source
 *      the caller (UI toast + the reddit-specific message) expects.
 *   2. inject metadata.handle (account) / metadata.slug (subreddit) — the URL-intrinsic,
 *      rename-proof walk join key the read-model (enrichRedditSourcesWithLastPolled) and
 *      backfillSource read. No upstream I/O: Reddit's key IS the immutable slug (lazy
 *      validation — a typo yields an empty first walk). Throws AppError 422 on an
 *      unparseable URL so a phantom source is never created.
 */
async function normalizeSourceOnCreate(
  input: NormalizeSourceInput,
): Promise<NormalizeSourceResult> {
  const parsed = redditParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a Reddit profile or subreddit URL (e.g. https://www.reddit.com/user/<name> or /r/<sub>).",
      "reddit_source_unresolvable",
      422,
      { handle_url: input.handleUrl },
    );
  }
  const metadata =
    parsed.kind === "reddit_subreddit" ? { slug: parsed.handle } : { handle: parsed.handle };
  return {
    handleUrl: parsed.externalUrl,
    channelId: input.channelId ?? null,
    metadata: { ...(input.metadata ?? {}), ...metadata },
  };
}

/**
 * canonicalizeOnCreate — PURE (no provider round-trip). Reddit's key IS the immutable,
 * rename-proof username/slug (Reddit forbids rename; the value is part of the canonical
 * URL — the safe denormalization), and ScrapeCreators exposes no user-profile endpoint,
 * so we resolve the source id from the pasted URL alone (lazy validation — a typo
 * yields an empty first walk, matching the diary tolerance). Throws AppError 422 on an
 * unparseable URL so a phantom source is never created.
 */
async function canonicalizeOnCreate(
  input: CanonicalizeInput,
  _ctx: CreateContext,
): Promise<CanonicalizeResult> {
  const parsed = redditParseSourceUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a Reddit profile or subreddit URL (e.g. https://www.reddit.com/user/<name> or /r/<sub>).",
      "reddit_source_unresolvable",
      422,
      { handle_url: input.handleUrl },
    );
  }
  const metadata =
    parsed.kind === "reddit_subreddit" ? { slug: parsed.handle } : { handle: parsed.handle };
  return {
    canonicalHandleUrl: parsed.externalUrl,
    resolvedExternalId: parsed.handle, // lowercase username / slug = the channelKey
    displayName: parsed.handle,
    metadata,
  };
}

/**
 * onSourceCreated — enqueue the initial backfill on createSource (inside the
 * createSource transaction via the shared outbox). Only fires when autoImport. Branches
 * on source.kind so the right walker runs.
 */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow; tx: Tx },
): Promise<void> {
  if (!source.autoImport) return;
  const md = (source.metadata ?? {}) as { handle?: string; slug?: string };
  const channelKey = source.channelId ?? md.handle ?? md.slug ?? source.id;
  const queue =
    source.kind === "reddit_subreddit"
      ? QUEUES.REDDIT_BACKFILL_SUBREDDIT
      : QUEUES.REDDIT_BACKFILL_ACCOUNT;
  await enqueueViaOutbox(
    opts.tx,
    queue,
    {
      kind: source.kind,
      channelKey,
      triggerUserId: source.userId,
      depthBoundIso: depthBoundIsoForWindow(opts.backfillWindow, source.backfillTargetSince),
      flow: "initial",
    },
    { singletonKey: `source-${source.id}` },
  );
}

/**
 * enqueueRefreshNow — the per-event Refresh-Now path. PER-POST: inserts ONE row into
 * the shared adapter_refresh_queue (queue_name "user_post"); the Reddit lane worker
 * fetches exactly that post + writeSnapshot. INSERT via the passed tx — no boss.send
 * outside the mutating transaction. The per-user cap is enforced upstream.
 */
async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  const { adapterRefreshQueue } = await import("$lib/server/db/schema/index.js");
  const { adapterRefreshQueueLabel } = await import("$lib/server/services/adapter-lane-worker.js");
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
 * fetchEventPreviewMetadata — the Add Event "Fetch" button. ONE by-URL provider request
 * (1 credit), cap-gated, then UPSERTs the reddit_posts cache + a snapshot so the saved
 * event renders fully in /feed. Cap + budget order mirrors TikTok/Twitter:
 *   1. enforceAdapterUserQuota (QUOTA_PLATFORM) — the per-user social cap.
 *   2. reserveSocialCredits (origin="user") inside provider.fetchPostByUrl — the
 *      operator prepaid budget gate (SOCIAL_PLATFORM, shared ScrapeCreators balance).
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const provider = getSocialProvider(SOCIAL_PLATFORM);
  if (provider === null) return { kind: "unreachable", cause: "reddit_not_configured" };

  const parsed = redditParsePostUrl(canonicalUrl);
  if (parsed === null) return { kind: "unreachable", cause: "url_not_reddit_post" };

  await enforceAdapterUserQuota(db, redditAdapter, ctx.userId, ctx.ipAddress, "post-refresh", {
    platform: QUOTA_PLATFORM,
  });

  let post;
  try {
    post = await provider.fetchPostByUrl(SOCIAL_PLATFORM, canonicalUrl, { origin: "user" });
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
  if (post === null) return { kind: "unavailable" };

  await writeSnapshot({
    postId: post.id,
    mediaType: null,
    title: post.caption,
    permalink: canonicalUrl,
    thumbnailUrl: post.thumbnailUrl,
    publishedAt: post.publishedAt,
    author: post.ownerUsername,
    authorFullname: post.ownerId,
    metrics: { likes: post.metrics.likes, comments: post.metrics.comments },
    raw: null,
    status: "ok",
  });

  await writeAudit({
    userId: ctx.userId,
    action: "event.poll_refreshed",
    ipAddress: ctx.ipAddress,
    metadata: {
      external_id: post.id,
      kind: "reddit_post",
      platform: QUOTA_PLATFORM,
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });

  const ownerUrl =
    post.ownerUsername !== null ? `https://www.reddit.com/user/${post.ownerUsername}` : "";
  return {
    kind: "ok",
    title: buildRedditTitle(post.caption) || `Reddit post · ${post.id}`,
    authorName: post.ownerUsername ?? "",
    authorUrl: ownerUrl,
    occurredAt: post.publishedAt,
    thumbnailUrl: post.thumbnailUrl ?? undefined,
    externalId: post.id,
  };
}

/**
 * resolveCachedExternalId — re-derive a reddit_post event's t3 id from the URL +
 * OUR reddit_posts cache, NEVER the request body (#70 untrusted-body boundary). The
 * Reddit post id is URL-INTRINSIC (the `/comments/<id>/` slug IS the base36 id), so
 * the parse itself is the authoritative re-derivation; the cache lookup confirms it.
 */
async function resolveCachedExternalId(url: string): Promise<string | null> {
  const parsed = redditParsePostUrl(url);
  if (parsed === null) return null;
  const t3 = `t3_${parsed.externalId}`;
  const [row] = await db
    .select({ postId: redditPosts.postId })
    .from(redditPosts)
    .where(eq(redditPosts.postId, t3))
    .orderBy(desc(redditPosts.updatedAt))
    .limit(1);
  return row?.postId ?? t3;
}

/**
 * validateEventInput — reddit_post URL-invariant for the merged-state PATCH gate
 * (mirrors youtube/telegram validateEventInput). The CREATE path enforces url-required
 * via its Zod schema; without this the PATCH merged-state validator (events-mutation.ts)
 * would let a client null the url on a reddit_post OR retag a non-Reddit event as
 * reddit_post — the razed adapter carried this check and the Phase-12 rewrite dropped it.
 */
function validateEventInput(input: { kind: string; url?: string | null }): void {
  if (input.kind !== "reddit_post") return;
  if (!input.url) {
    throw new AppError("url is required when kind=reddit_post", "kind_url_inconsistent", 422, {
      reason: "reddit_post_requires_url",
    });
  }
  if (redditParsePostUrl(input.url) === null) {
    throw new AppError("url is not a recognized Reddit post URL", "kind_url_inconsistent", 422, {
      reason: "url_not_reddit_post",
    });
  }
}

// NO registerRoutes: no same-origin thumbnail proxy (Pitfall 5 — hotlink + onerror;
// the image/gallery card variant is confirmed at 12-06 UAT). Do NOT pre-build it.

export const redditAdapter: SourceAdapter & typeof redditAccountAdapterCore = {
  ...redditAccountAdapterCore,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  normalizeSourceOnCreate,
  canonicalizeOnCreate,
  onSourceCreated,
  fetchEventPreviewMetadata,
  resolveCachedExternalId,
  validateEventInput,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "reddit_post",
    canRun: async () => {
      // Block when the provider is unconfigured: the lane worker's isEnabled gates OFF
      // when getSocialProvider is null, so an enqueued row would NEVER run — an orphan
      // pending row + a forever-spinning Refresh button.
      if (getSocialProvider(SOCIAL_PLATFORM) === null) {
        return { action: "skip", reason: "reddit not configured" };
      }
      const throttle = await getSocialThrottleState(SOCIAL_PLATFORM, "scrapecreators");
      return throttle === "ninetyfive"
        ? { action: "skip", reason: "reddit budget at 95%" }
        : { action: "run" };
    },
    enqueue: enqueueRefreshNow,
  },
  workQueue: {
    scheduledWorkers: [
      {
        name: "reddit.refresh",
        intervalMs: 1000,
        replicaPolicy: "parallel",
        readyMessage: "reddit refresh queue worker ready",
        disabledMessage: "reddit refresh queue worker disabled (provider unconfigured)",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: KIND,
          slots: REDDIT_REFRESH_SLOTS,
          fallthrough: REDDIT_REFRESH_SLOTS,
          batchScope: "global",
        },
        isEnabled: () => getSocialProvider(SOCIAL_PLATFORM) !== null,
        tick: redditRefreshQueueTick,
      },
    ],
  },
};

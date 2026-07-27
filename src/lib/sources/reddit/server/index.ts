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
//   reddit.poll.cron            (key=active daily 06:00 UTC / key=cold daily; NO warm — disabled)
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
import { env } from "$lib/server/config/env.js";
import { QUEUES, REDDIT_WALK_QUEUE_OPTIONS } from "$lib/server/queues.js";
import { db } from "$lib/server/db/client.js";
import { outbox } from "$lib/server/db/schema/outbox.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { backfillWindowToDate } from "$lib/server/services/data-sources.js";
import {
  enforceAdapterUserQuota,
  getUserQuotaUsedToday,
  nextPacificMidnight,
} from "$lib/server/services/quota.js";
import { getChannelState } from "$lib/server/services/channel-state.js";
import { AppError, NotFoundError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { redditAccountAdapterCore } from "./adapter.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { buildRedditTitle } from "./normalize.js";
import { getSocialThrottleState } from "./quota.js";
import { getSocialProvider } from "./provider/registry.js";
import type { RedditSocialProvider } from "./provider/scrapecreators-reddit.js";
import { writeSnapshot } from "./snapshots.js";
import {
  resetRedditBackfillState,
  redditWalkSingletonKey,
  type RedditSourceKind,
} from "./backfill-state.js";
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
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_ACCOUNT, REDDIT_WALK_QUEUE_OPTIONS);
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_SUBREDDIT, REDDIT_WALK_QUEUE_OPTIONS);
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_ACCOUNT_LEGACY);
  await boss.createQueue(QUEUES.REDDIT_BACKFILL_SUBREDDIT_LEGACY);
  await boss.createQueue(QUEUES.REDDIT_POLL_CRON);
  await boss.createQueue(QUEUES.REDDIT_QUOTA_RESET);
  await boss.createQueue(QUEUES.REDDIT_DELETION_PROPAGATION);

  await boss.work(QUEUES.REDDIT_BACKFILL_ACCOUNT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleBackfillAccount(job as never);
  });
  await boss.work(QUEUES.REDDIT_BACKFILL_SUBREDDIT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleBackfillSubreddit(job as never);
  });
  await boss.work(QUEUES.REDDIT_BACKFILL_ACCOUNT_LEGACY, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await bridgeLegacyWalkJob(
        boss,
        QUEUES.REDDIT_BACKFILL_ACCOUNT,
        job as { id: string; data: Record<string, unknown> },
      );
    }
  });
  await boss.work(QUEUES.REDDIT_BACKFILL_SUBREDDIT_LEGACY, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await bridgeLegacyWalkJob(
        boss,
        QUEUES.REDDIT_BACKFILL_SUBREDDIT,
        job as { id: string; data: Record<string, unknown> },
      );
    }
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

async function bridgeLegacyWalkJob(
  boss: MinimalBoss,
  queue: string,
  job: { id: string; data: Record<string, unknown> },
): Promise<void> {
  const kind = job.data.kind;
  const channelKey = job.data.channelKey;
  if (
    (kind !== "reddit_account" && kind !== "reddit_subreddit") ||
    typeof channelKey !== "string" ||
    channelKey === ""
  ) {
    return;
  }
  const singletonKey = redditWalkSingletonKey(kind, channelKey);
  const sentId = await boss.send(queue, job.data, { id: job.id, singletonKey });
  const alreadyForwarded =
    boss.getJobById === undefined ? null : await boss.getJobById(queue, job.id);
  if (sentId !== null || alreadyForwarded !== null) return;

  await db
    .insert(outbox)
    .values({
      id: job.id,
      queue,
      payload: job.data,
      options: { singletonKey, retrySingletonConflict: true },
    })
    .onConflictDoNothing();
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
  // NO warm per-post schedule (review fix): ScrapeCreators has no lookup-by-id, so
  // the warm catch could only search the subreddit's page 1 — a post that fell off
  // the daily walk is almost never there, and each attempt burned a credit for a
  // not_found. poll-cron keeps a defensive tier=warm no-op branch for any stale
  // pg-boss schedule a pre-disable deploy persisted.
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
  const payload = {
    kind,
    channelKey,
    triggerUserId: ctx.origin === "user" ? source.userId : undefined,
    depthBoundIso: EPOCH_ISO,
    flow: ctx.origin === "user" ? "incremental" : "auto_passive",
  };
  const jobId = await db.transaction((tx) =>
    enqueueViaOutbox(tx, queue, payload, {
      singletonKey: redditWalkSingletonKey(kind, channelKey),
      priority: ctx.origin === "user" ? 1 : 0,
      retrySingletonConflict: true,
    }),
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
  // Reject a kind/URL mismatch at the EARLIEST boundary (before duplicate/quota
  // prechecks). A `reddit_account` request with a `/r/<sub>` URL (or vice-versa) would
  // otherwise persist metadata.slug on an account-kind row: onSourceCreated branches on
  // source.kind → the AUTHOR queue, while backfillSource discriminates on metadata.slug
  // → the SUBREDDIT queue, so the initial walk and every later refresh dispatch to
  // DIFFERENT queues on inconsistent state. 422 here keeps kind and URL in lockstep.
  if (parsed.kind !== input.kind) {
    throw new AppError(
      `That URL is a ${parsed.kind === "reddit_subreddit" ? "subreddit" : "user profile"} but the source kind is ${input.kind}. Paste the matching URL.`,
      "reddit_kind_url_mismatch",
      422,
      { requested_kind: input.kind, url_kind: parsed.kind, handle_url: input.handleUrl },
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
  // This hook only ever fires for reddit sources; narrow SourceKind → RedditSourceKind
  // (the queue branch already discriminates on it) so redditWalkSingletonKey type-checks.
  const kind: RedditSourceKind =
    source.kind === "reddit_subreddit" ? "reddit_subreddit" : "reddit_account";
  const md = (source.metadata ?? {}) as { handle?: string; slug?: string };
  const channelKey = source.channelId ?? md.handle ?? md.slug ?? source.id;
  const queue =
    kind === "reddit_subreddit" ? QUEUES.REDDIT_BACKFILL_SUBREDDIT : QUEUES.REDDIT_BACKFILL_ACCOUNT;
  await enqueueViaOutbox(
    opts.tx,
    queue,
    {
      kind,
      channelKey,
      triggerUserId: source.userId,
      depthBoundIso: depthBoundIsoForWindow(opts.backfillWindow, source.backfillTargetSince),
      flow: "initial",
    },
    // Channel-scoped singleton (NOT per-source `source-${id}`): two tenants who add the
    // SAME channel must dedupe to ONE initial walk, not double-spend on concurrent walks
    // of the same feed. Shared across initial/manual/cron (redditWalkSingletonKey).
    // pg-boss only DEFERS the conflicting intent; what actually makes this ONE paid walk
    // is walk-core's coalescePendingIntents, which settles the deferred intent by
    // re-running the fan-out over the pages this walk already fetched.
    {
      singletonKey: redditWalkSingletonKey(kind, channelKey),
      retrySingletonConflict: true,
    },
  );
}

/**
 * resetWalkerStateOnWidening — fired by cross-source updateSource when the user widens
 * backfillTargetSince past the recorded frontier on a COMPLETE Reddit source (e.g. "7
 * days" → "everything"). Without it, the adapter omits the hook, updateSource's
 * `adapter.resetWalkerStateOnWidening !== undefined` guard is false, and the widen is a
 * silent no-op — the exhausted walker never re-opens, so the deeper history never loads
 * (the very case data-sources.ts:855 documents Reddit handling). Clears the resumable
 * sub-state + enqueues a forceDeep historical walk (BUDGET-02: the trigger user pays the
 * per-user cap; subscribers free-ride). Runs inside the updateSource tx.
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
  if (source.kind !== "reddit_account" && source.kind !== "reddit_subreddit") return;
  // Capture the narrowed kind: TS loses property narrowing on `source.kind` across the
  // awaits below, and resetRedditBackfillState is strictly typed to RedditSourceKind.
  const kind = source.kind;
  const md = (source.metadata ?? {}) as { handle?: string; slug?: string };
  const channelKey = source.channelId ?? md.handle ?? md.slug ?? null;
  if (channelKey === null || channelKey === "") return;

  // Defend-in-depth: only act on a genuine widen (updateSource already gates on this).
  if (ctx.previousTarget !== null && ctx.newTarget.getTime() >= ctx.previousTarget.getTime()) {
    return;
  }
  const state = await getChannelState(kind, channelKey);
  if (!state) return;
  if (state.backfillComplete !== true) return;
  if (state.backfillOldestAt === null) return;
  // Nothing deeper to fetch: the new target is not below the walked frontier.
  if (ctx.newTarget.getTime() >= state.backfillOldestAt.getTime()) return;

  // Per-user fair-share cap — a PATCH widen burns the same budget as a refresh-content
  // click, so gate it here too (QUOTA_PLATFORM for Reddit IS the source kind — the
  // per-kind keyspace; using "reddit" would read 0 forever, Phase 10 two-keyspace lesson).
  const cap = redditAccountAdapterCore.observability.userQuotaCap;
  if (cap?.requestsPerDay !== undefined) {
    const used = await getUserQuotaUsedToday(ctx.triggerUserId, kind);
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

  // Clear the resumable sub-state so the forceDeep walk re-enters page 1 toward the new,
  // deeper target (forceDeep overrides the "exhausted" branch in the walk core).
  await resetRedditBackfillState(kind, channelKey, ctx.tx);

  const queue =
    kind === "reddit_subreddit" ? QUEUES.REDDIT_BACKFILL_SUBREDDIT : QUEUES.REDDIT_BACKFILL_ACCOUNT;
  await enqueueViaOutbox(
    ctx.tx,
    queue,
    {
      kind,
      channelKey,
      triggerUserId: ctx.triggerUserId,
      depthBoundIso: ctx.newTarget.toISOString(),
      flow: "historical",
      forceDeep: true,
    },
    {
      singletonKey: redditWalkSingletonKey(source.kind, channelKey),
      retrySingletonConflict: true,
    },
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
  const [event] = await dbCtx
    .select({ url: events.url })
    .from(events)
    .where(
      and(
        eq(events.id, input.eventId),
        eq(events.userId, input.userId),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  if (event === undefined) throw new NotFoundError();
  const parsed = event.url === null ? null : redditParsePostUrl(event.url);
  const subreddit = (parsed?.metadata?.subreddit as string | null | undefined) ?? null;
  if (parsed !== null && subreddit === null) {
    throw new AppError(
      "Reddit URL has no subreddit feed to refresh",
      "reddit_short_link_unsupported",
      422,
    );
  }
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
  const provider = getSocialProvider(SOCIAL_PLATFORM) as RedditSocialProvider | null;
  if (provider === null) return { kind: "unreachable", cause: "reddit_not_configured" };

  const parsed = redditParsePostUrl(canonicalUrl);
  if (parsed === null) return { kind: "unreachable", cause: "url_not_reddit_post" };

  // RECOGNITION-ONLY short link (review fix): `redd.it/<id>` carries no subreddit, and
  // ScrapeCreators exposes neither lookup-by-id nor a redirect follower — the provider
  // could only ever return null here. Say so BEFORE the cap gate: the pre-fix order
  // spent a per-user quota slot (enforceAdapterUserQuota writes the counter audit row)
  // on a request that never left the process, and reported the dead-end as the generic
  // "unavailable" (indistinguishable from a deleted post). The URL still parses, so the
  // user can save the event as a stats-less manual card — or re-paste the full
  // /r/<sub>/comments/<id> permalink to get live data.
  const parsedSubreddit = (parsed.metadata?.subreddit as string | null | undefined) ?? null;
  if (parsedSubreddit === null) {
    return { kind: "unreachable", cause: "reddit_short_link_unsupported" };
  }

  await enforceAdapterUserQuota(db, redditAdapter, ctx.userId, ctx.ipAddress, "post-refresh", {
    platform: QUOTA_PLATFORM,
  });

  // A paid HTTP request that was ISSUED spent its credit even when it then failed or
  // resolved no post — it must reach the per-user cap audit (review fix; mirrors
  // walk-core). Issued-error discriminator: an HTTP-status AdapterError carries a
  // numeric context.status; a reserve-null denial carries none (nothing was spent).
  // Every path below this point DID issue the request (the one no-fetch case, the
  // redd.it short link, already returned above).
  let post;
  try {
    post = await provider.fetchPostByUrl(SOCIAL_PLATFORM, canonicalUrl, {
      origin: "user",
      userAccounting: {
        requestsPerDay: env.LIMIT_SOCIAL_REQUESTS_PER_DAY,
        auditEntry: {
          userId: ctx.userId,
          action: "event.poll_refreshed",
          ipAddress: ctx.ipAddress,
          metadata: {
            external_id: `t3_${parsed.externalId}`,
            kind: "reddit_post",
            platform: QUOTA_PLATFORM,
            flow: "stats_refresh",
            requests_used: 1,
            events_inserted: 0,
          },
        },
      },
    });
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
  if (post === null) {
    return { kind: "unavailable" };
  }

  await writeSnapshot({
    postId: post.id,
    // Persist the real Reddit FORM (image/gallery/self/link) the provider derived, so
    // the feed card renders its media variant immediately (was hard-coded null → text).
    mediaType: post.mediaType ?? null,
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
 * resolveCachedAuthorIsMe — per-post ownership for a PASTED reddit_post.
 *
 * A Reddit source can carry other people's content (a subreddit feed always does), so
 * ownership is a property of the POST's author, never of the source row — the same rule
 * the walk applies via resolveOwnedUsernames (CHECKLIST §3). Without this the create
 * path had no author match at all: a dev pasting their OWN post, with u/<handle>
 * registered as an owned account, still got it filed as somebody else's until a walk
 * happened to re-cover that post. Reads the author from OUR cache (written by the
 * preview), never from the request body.
 */
async function resolveCachedAuthorIsMe(userId: string, externalId: string): Promise<boolean> {
  const [post] = await db
    .select({ author: redditPosts.author })
    .from(redditPosts)
    .where(eq(redditPosts.postId, externalId))
    .limit(1);
  if (!post?.author) return false;
  const [owned] = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.kind, "reddit_account"),
        eq(dataSources.isOwnedByMe, true),
        isNull(dataSources.deletedAt),
        sql`LOWER(${dataSources.channelId}) = ${post.author.toLowerCase()}`,
      ),
    )
    .limit(1);
  return owned !== undefined;
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
  resetWalkerStateOnWidening,
  fetchEventPreviewMetadata,
  resolveCachedExternalId,
  resolveCachedAuthorIsMe,
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

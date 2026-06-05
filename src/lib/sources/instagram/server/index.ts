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
import { logger } from "$lib/server/logger.js";
import { instagramAccountAdapterCore } from "./adapter.js";
import { instagramParseSourceUrl } from "./url.js";
import { resetInstagramBackfillState } from "./backfill-state.js";
import { getSocialThrottleState } from "./quota.js";
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

  // batchSize=1 keeps the backfill stream single-flight per worker; the
  // producer-side singletonKey by channelKey dedupes parallel triggers across
  // users to the same account.
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
  await boss.schedule(
    QUEUES.INSTAGRAM_QUOTA_RESET,
    "0 0 * * *",
    {},
    { tz: "America/Los_Angeles" },
  );
}

/**
 * backfillSource — user-driven "Pull new content" / cron-driven initial-fetch.
 * Enqueues an account-level walk. singletonKey by channelKey dedupes parallel
 * triggers across users; priority puts user-initiated jobs ahead of cron walks.
 * The trigger user pays the per-user cap (origin==="user"); subscribers
 * free-ride on the channel-wide fan-out.
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
  const resolved = await instagramAccountAdapterCore.resolveHandleToAccountId(parsed.handle);
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
    .select({ accountId: instagramPosts.postId, account: instagramPosts.accountId })
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

// instagramAdapter — composes the polling core (./adapter.ts) with the
// infrastructure-touching methods (registerQueues / scheduleCronTicks /
// backfillSource) and the create-time hooks (canonicalizeOnCreate /
// onSourceCreated / resetWalkerStateOnWidening / refreshQueue). The
// `SourceAdapter & typeof core` annotation fails the build if any required
// contract method is missing from the spread — completeness check by construction.
export const instagramAdapter: SourceAdapter & typeof instagramAccountAdapterCore = {
  ...instagramAccountAdapterCore,
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canonicalizeOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
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

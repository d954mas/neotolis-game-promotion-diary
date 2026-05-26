// YouTube per-source server barrel.
// Cross-source code (registry, worker entrypoints) imports from here.
// The internal modules (adapter, http, schema, handlers) are wired
// together inside this folder; consumers see only the adapter export.
//
// Per-kind queue topology:
//   youtube.poll.cron (key=active)
//   youtube.poll.cron (key=cold)
//   adapter_refresh_queue:youtube_channel:user_video
//   youtube.backfill.channel
//   youtube.rehab
//   youtube.quota_reset
//   youtube.channel_context_backfill
//
// Active vs Cold collapse into a single youtube.poll.cron queue via
// boss.schedule({key}) per pg-boss v11+ multiple-schedules-per-queue. The
// poll-cron handler (./handlers/poll-cron.ts) reads job.data.tier and
// dispatches to handlePollActive / handlePollCold.
//
// scheduleCronTicks is the per-kind cron registration entrypoint.
// Cross-source crons (purge.daily, internal.healthcheck) stay in
// src/scheduler/index.ts because they apply across all sources, not just
// YouTube.
//
// batchSize values:
//   YOUTUBE_POLL_CRON                 batchSize=4 (Active concurrency)
//   YOUTUBE_BACKFILL_CHANNEL          batchSize=1
//   YOUTUBE_CHANNEL_CONTEXT_BACKFILL  batchSize=1
//   YOUTUBE_QUOTA_RESET               batchSize=1
//   YOUTUBE_REHAB                     batchSize=1
//
// The poll-cron handler internally distinguishes Active (cron every 6h,
// throttle skip on ninetyfive) vs Cold (cron daily 5am PT, throttle skip
// on eighty AND ninetyfive) via the tier-tagged payload. Cold's
// effectively-once-daily concurrency is shaped by the cron schedule, not
// by a separate queue's batchSize.

import type {
  AdapterAppContext,
  AdapterContext,
  AdapterCapabilityGuardResult,
  AdapterPollState,
  AdapterQuotaCounter,
  BackfillWindow,
  CanonicalizeInput,
  CanonicalizeResult,
  CreateContext,
  SourceAdapter,
  EventKind,
  EventPreviewMetadata,
  MinimalBoss,
  PollableSource,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { DbOrTx, Tx } from "$lib/server/db/client.js";
import type { Hono } from "hono";
import { QUEUES } from "$lib/server/queues.js";
import { getBoss } from "$lib/server/queue-client.js";
import { youtubeChannelAdapterCore } from "./adapter.js";
import { handlePollCron } from "./handlers/poll-cron.js";
import { handleRehabUnavailable } from "./handlers/rehab-unavailable.js";
import { handleChannelContextBackfill } from "./handlers/channel-context-backfill.js";
import { handleQuotaReset } from "./handlers/quota-reset.js";
// Channel-scoped backfill handler. Job payload carries (kind, channelKey,
// triggerUserId?, depthBoundIso, flow); handler walks channel once and
// fans out events INSERT to all active subscribers.
import { handleBackfillChannel } from "./handlers/backfill-channel.js";
// Daily auto-backfill cron picker. Skip-gates when the cron pool is
// >= 50% used; enqueues channel backfill with metadata.flow='auto_passive'.
import { handleAutoBackfillCron } from "./handlers/auto-backfill-cron.js";
// Daily incremental cron. Walks page 1 of every active channel including
// completed ones to discover new uploads.
import { handleIncrementalCron } from "./handlers/incremental-cron.js";
// Adapter-driven create-time hooks + preview metadata + poll-state
// lookup + per-source HTTP routes. Cross-source services delegate via
// getAdapter(...) so adding a new source kind is a registry entry, not a
// 6-file edit.
import { fetchVideoMetadataByUrl } from "./metadata.js";
import { writeSnapshot } from "./snapshots.js";
import {
  getThrottleState,
  hasYoutubeApiKeys,
  msUntilMidnightPacific,
  reserveYoutubeQuota,
  youtubeQuotaUser,
} from "./quota.js";
import { parseYoutubeUrl, youtubeParseUrl } from "./url.js";
import { fetchYoutubeOembed } from "$lib/server/integrations/youtube-oembed.js";
import { youtubeMetadataRoutes } from "./route-metadata.js";
import { youtubeVideos, youtubeMetadataFetchLog } from "./schema/index.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { adapterRefreshQueueLabel } from "$lib/server/services/adapter-lane-worker.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { getChannelState } from "$lib/server/services/channel-state.js";
import { getUserQuotaUsedToday, nextPacificMidnight } from "$lib/server/services/quota.js";
import { AppError } from "$lib/server/services/errors.js";
import {
  youtubeRefreshQueueTick,
  YOUTUBE_REFRESH_SLOT_MAPPING,
  YOUTUBE_REFRESH_FALLTHROUGH_ORDER,
} from "./handlers/refresh-queue-tick.js";
import { events } from "$lib/server/db/schema/events.js";
import { db } from "$lib/server/db/client.js";
import { eq, and, gte, count, inArray, sql } from "drizzle-orm";
import { logger } from "$lib/server/logger.js";
import { writeAudit } from "$lib/server/audit.js";

async function registerQueues(boss: MinimalBoss): Promise<void> {
  // pg-boss v10+ requires createQueue before send/work — idempotent on
  // every boot. queues.ts.declareAllQueues() is still called at worker
  // bootstrap time for the cross-source roster; this function declares
  // the YouTube-specific queues again (idempotent) so the adapter's
  // registration is self-contained — Reddit/Twitter adapters follow the
  // same pattern.
  await boss.createQueue(QUEUES.YOUTUBE_POLL_CRON);
  await boss.createQueue(QUEUES.YOUTUBE_BACKFILL_CHANNEL);
  await boss.createQueue(QUEUES.YOUTUBE_QUOTA_RESET);
  await boss.createQueue(QUEUES.YOUTUBE_REHAB);
  await boss.createQueue(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL);
  await boss.createQueue(QUEUES.YOUTUBE_AUTO_BACKFILL_CRON);
  await boss.createQueue(QUEUES.YOUTUBE_INCREMENTAL_CRON);

  // youtube.poll.cron — Active+Cold collapsed via tier-tagged payload.
  // batchSize=4 matches POLL_ACTIVE concurrency (Cold's daily cadence
  // keeps it from saturating the budget regardless).
  await boss.work(QUEUES.YOUTUBE_POLL_CRON, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollCron(
        job as { id?: string; data: { tier: "active" | "cold" } & Record<string, unknown> },
      );
    }
  });

  // youtube.backfill.channel worker subscription. batchSize=1 keeps the
  // backfill stream single-flight per worker process; pg-boss singletonKey
  // by channelKey on the producer side dedupes parallel triggers across
  // multiple users to the same channel.
  await boss.work(QUEUES.YOUTUBE_BACKFILL_CHANNEL, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillChannel(
        job as {
          id?: string;
          data: {
            kind: "youtube_channel";
            channelKey: string;
            triggerUserId?: string;
            depthBoundIso: string;
            flow: "initial" | "incremental" | "historical" | "auto_passive";
          };
        },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleChannelContextBackfill(
        job as {
          id: string;
          data: {
            userId: string;
            channelId?: string;
            handleUrl?: string;
            sourceId?: string;
            backfillWindow?: "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
          };
        },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_QUOTA_RESET, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleQuotaReset(job as { id: string; data: object });
    }
  });

  await boss.work(QUEUES.YOUTUBE_REHAB, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleRehabUnavailable(job as { id: string });
    }
  });

  // Daily auto-backfill cron picker. batchSize=1 — single tick per day,
  // picks ≤50 sources, enqueues passive jobs into
  // YOUTUBE_BACKFILL_CHANNEL. Handler does the gate check (skip if pool
  // ≥50%).
  await boss.work(QUEUES.YOUTUBE_AUTO_BACKFILL_CRON, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleAutoBackfillCron(job as { id: string; data: object }, boss);
    }
  });

  // Daily incremental cron. Single tick per day at 04:00 PT (1h after
  // auto-backfill). Picks complete + incomplete channels with active
  // auto_import subscribers; enqueues page-1 walks (1 quota unit each)
  // on YOUTUBE_BACKFILL_CHANNEL. Closes the new-upload-discovery gap on
  // completed channels.
  await boss.work(QUEUES.YOUTUBE_INCREMENTAL_CRON, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleIncrementalCron(job as { id: string; data: object }, boss);
    }
  });
}

/**
 * Registers the YouTube-specific cron schedules:
 *
 *   - youtube.poll.cron, key=active — every 6 hours UTC default. Sends
 *     `{ tier: "active" }` payload; the poll-cron handler dispatches.
 *   - youtube.poll.cron, key=cold   — daily 5am Pacific. Sends
 *     `{ tier: "cold" }` payload.
 *   - youtube.quota_reset           — midnight Pacific (YouTube's daily
 *     quota reset boundary).
 *   - youtube.rehab                 — weekly Sunday 4am Pacific (recovers
 *     privacy-unflipped videos; ~50 ids/week).
 *
 * Cross-source crons (purge.daily, internal.healthcheck) stay in
 * src/scheduler/index.ts — they apply across all sources, not just
 * YouTube. src/scheduler/index.ts iterates allAdapters and calls
 * adapter.scheduleCronTicks(boss) for each per-kind set.
 *
 * Pacific-time schedules use `tz: "America/Los_Angeles"` so DST
 * transitions are handled by pg-boss; the active tier's "every 6 hours"
 * cron is left as UTC default (operator can revisit if the time-of-day
 * shift matters at higher volumes).
 */
async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — every 6 hours UTC.
  await boss.schedule(
    QUEUES.YOUTUBE_POLL_CRON,
    "0 */6 * * *",
    { tier: "active" },
    { key: "active" },
  );
  // Cold tier — daily 5am Pacific.
  await boss.schedule(
    QUEUES.YOUTUBE_POLL_CRON,
    "0 5 * * *",
    { tier: "cold" },
    { key: "cold", tz: "America/Los_Angeles" },
  );
  // Quota reset — midnight Pacific.
  await boss.schedule(QUEUES.YOUTUBE_QUOTA_RESET, "0 0 * * *", {}, { tz: "America/Los_Angeles" });
  // Rehab — weekly Sunday 4am Pacific.
  await boss.schedule(QUEUES.YOUTUBE_REHAB, "0 4 * * 0", {}, { tz: "America/Los_Angeles" });
  // Auto-backfill picker daily 03:00 Pacific (3h after quota reset at
  // 00:00 PT — pool fresh, minimal contention with active/cold poll).
  // Handler does the gate check (skip if pool ≥50% used) and picker
  // SELECTs incomplete sources, enqueuing passive backfill jobs.
  await boss.schedule(
    QUEUES.YOUTUBE_AUTO_BACKFILL_CRON,
    "0 3 * * *",
    {},
    { tz: "America/Los_Angeles" },
  );
  // Daily incremental cron at 04:00 Pacific (1h after auto-backfill).
  // Walks page 1 of every active channel including completed ones to
  // discover new uploads. Same gate-check as auto-backfill (skip if cron
  // pool ≥50%).
  await boss.schedule(
    QUEUES.YOUTUBE_INCREMENTAL_CRON,
    "0 4 * * *",
    {},
    { tz: "America/Los_Angeles" },
  );
}

/**
 * Channel-scoped backfillSource. Enqueues a channel-level walk job.
 * Triggering user pays quota; ALL active subscribers to the channel
 * receive events.
 *
 * singletonKey=`backfill-channel-${channelKey}` dedups concurrent triggers
 * across users — two parallel clicks on the same channel (different users)
 * coalesce into one walk. Trigger user is the FIRST to enqueue; subsequent
 * clicks return null jobId (pg-boss singleton coalesce) and free-ride the
 * walk's results once it completes.
 *
 * AdapterContext threads triggerUserId (the clicking user) and the
 * walk's depth bound (target_since for user-triggered, sentinel for cron).
 *
 * priority=1 puts user-initiated jobs ahead of cron-initiated walks in
 * the same queue (user-pool reserve).
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const channelKey = (source.metadata as { channelId?: string })?.channelId ?? source.id;
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.YOUTUBE_BACKFILL_CHANNEL,
    {
      kind: "youtube_channel" as const,
      channelKey,
      triggerUserId: ctx.origin === "user" ? source.userId : undefined,
      depthBoundIso:
        (source.metadata as { backfillTargetSince?: string })?.backfillTargetSince ??
        "1970-01-01T00:00:00Z",
      flow: ctx.origin === "user" ? "incremental" : "auto_passive",
    },
    {
      singletonKey: `backfill-channel-${channelKey}`,
      priority: ctx.origin === "user" ? 1 : 0,
    },
  );
  return { jobId, queue: QUEUES.YOUTUBE_BACKFILL_CHANNEL };
}

/**
 * canonicalizeOnCreate — YouTube channel/video URL canonicalization
 * called by services/data-sources.ts on createSource.
 *
 *   - /channel/UC… → resolvedExternalId = channelId, canonicalize URL.
 *   - /watch?v=ID  → fetchVideoMetadataByUrl, dereference channelId, canonicalize.
 *   - /@handle, /c/, /user/ → leave as-is; worker resolves on first backfill.
 *
 * Throws AppError 422 on URLs that don't point at a YouTube
 * channel/handle/video (better fail visibly than register a phantom
 * source).
 */
async function canonicalizeOnCreate(
  input: CanonicalizeInput,
  ctx: CreateContext,
): Promise<CanonicalizeResult> {
  if (input.channelId != null && input.channelId !== "") {
    return { canonicalHandleUrl: input.handleUrl, resolvedExternalId: input.channelId };
  }
  const parsed = parseYoutubeUrl(input.handleUrl);
  if (parsed === null) {
    throw new AppError(
      "Paste a YouTube channel URL (e.g. https://www.youtube.com/@handle or /channel/UC… or any video URL).",
      "validation_failed",
      422,
      { handle_url: input.handleUrl },
    );
  }
  if (parsed.kind === "channelId") {
    return {
      canonicalHandleUrl: `https://www.youtube.com/channel/${parsed.value}`,
      resolvedExternalId: parsed.value,
    };
  }
  if (parsed.kind === "videoId") {
    // /watch?v=… or /shorts/… — dereference channelId via videos.list.
    // fetch failures (404, 502, 503 missing keys) propagate up as AppError —
    // ghost rows with channel_id=NULL are worse UX than visible failure.
    const meta = await fetchVideoMetadataByUrl(input.handleUrl, ctx.userId, ctx.ipAddress);
    if (meta.channelId) {
      return {
        canonicalHandleUrl: `https://www.youtube.com/channel/${meta.channelId}`,
        resolvedExternalId: meta.channelId,
      };
    }
    return { canonicalHandleUrl: input.handleUrl, resolvedExternalId: null };
  }
  // parsed.kind === "handle" — /@handle, /c/legacy, /user/legacy. Leave as-is;
  // the worker resolves channel_id on first backfill (1 quota unit) and
  // persists it back to data_sources.
  return { canonicalHandleUrl: input.handleUrl, resolvedExternalId: null };
}

/**
 * onSourceCreated — enqueue the channel-context backfill on createSource.
 *
 * Zero-quota onboarding: before enqueueing the channel-context-backfill
 * job, we check if the channel cache already has data (other users have
 * walked this channel before). If yes, we bulk INSERT events for the new
 * subscriber from cache without making any HTTP calls — the user gets an
 * instantly-populated feed and zero quota is consumed. The cron walks
 * (auto-backfill / incremental) still run later to top up new uploads.
 *
 * The enqueue happens through the shared outbox in the same transaction as
 * source creation. If cache seeding or outbox insert fails, the source row
 * rolls back too; the first backfill is part of successful onboarding.
 */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow; tx: Tx },
): Promise<void> {
  if (!source.autoImport) return;

  // Zero-quota onboarding. Only fires when channelId resolved at create
  // time (i.e., /channel/UC... URL or /watch?v= URL with synchronous
  // resolution). For /@handle URLs the channel-context-backfill worker
  // resolves channelId AFTER the HTTP call, so this branch is skipped
  // and the worker takes the normal HTTP path.
  if (source.channelId !== null) {
    const seeded = await seedEventsFromChannelCache({
      userId: source.userId,
      sourceId: source.id,
      channelId: source.channelId,
      targetSince: source.backfillTargetSince,
      isOwnedByMe: source.isOwnedByMe,
      dbCtx: opts.tx,
    });
    if (seeded > 0) {
      logger.info(
        { sourceId: source.id, channelId: source.channelId, seeded },
        "youtube.onSourceCreated: zero-quota seed from cache",
      );
    }
  }

  await enqueueViaOutbox(
    opts.tx,
    QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL,
    {
      sourceId: source.id,
      userId: source.userId,
      handleUrl: source.handleUrl,
      backfillWindow: opts.backfillWindow,
    },
    { singletonKey: `source-${source.id}` },
  );
}

/**
 * Bulk-INSERT events for a new subscriber from the youtube_videos cache.
 * Triggered by onSourceCreated when channelId is resolved synchronously
 * and another user has previously walked this channel (cache populated).
 *
 * Idempotency UNIQUE on (user_id, source_id, kind, external_id) protects
 * against double-INSERT if multiple createSource calls race.
 *
 * Returns: number of events seeded. 0 means cache miss (channel never
 * walked) — caller's HTTP backfill path takes over.
 */
async function seedEventsFromChannelCache(args: {
  userId: string;
  sourceId: string;
  channelId: string;
  targetSince: Date | null;
  isOwnedByMe: boolean;
  dbCtx?: DbOrTx;
}): Promise<number> {
  const dbCtx = args.dbCtx ?? db;
  // Cache lookup — youtube_videos is global (PK=video_id). Filter by
  // channel + target_since boundary so we don't seed events older than
  // the user's preference.
  const sinceFilter = args.targetSince ?? new Date("1970-01-01T00:00:00Z");
  const cached = await dbCtx
    .select({
      videoId: youtubeVideos.videoId,
      title: youtubeVideos.title,
      publishedAt: youtubeVideos.publishedAt,
      channelId: youtubeVideos.channelId,
    })
    .from(youtubeVideos)
    .where(
      and(
        eq(youtubeVideos.channelId, args.channelId),
        // published_at IS NOT NULL — pre-resolution rows are excluded
        // (a partial-index materialization of the same gate).
        sql`${youtubeVideos.publishedAt} IS NOT NULL`,
        sql`${youtubeVideos.publishedAt} >= ${sinceFilter.toISOString()}::timestamptz`,
      ),
    );
  if (cached.length === 0) return 0;

  // Bulk INSERT — one round-trip via Drizzle's values([]). Idempotency
  // UNIQUE on events handles concurrent races (two createSource calls
  // for the same user against the same channel — second hits the unique
  // and we skip with onConflictDoNothing).
  const rowsToInsert = cached.map((c) => ({
    userId: args.userId,
    sourceId: args.sourceId,
    kind: "youtube_video" as const,
    authorIsMe: args.isOwnedByMe,
    occurredAt: c.publishedAt!,
    title: c.title,
    url: `https://www.youtube.com/watch?v=${c.videoId}`,
    externalId: c.videoId,
    metadata: { channelId: c.channelId } as Record<string, unknown>,
  }));
  await dbCtx.insert(events).values(rowsToInsert).onConflictDoNothing();
  return rowsToInsert.length;
}

/**
 * fetchEventPreviewMetadata — adapter wrapper around the YouTube oEmbed
 * call. Maps YoutubeOembedResult → EventPreviewMetadata so the cross-
 * source code never sees YouTube-specific result shapes.
 *
 * 5xx / network failures are caught here and translated to
 * `{kind:'unreachable'}` — cross-source enrichFromUrl maps to AppError
 * 502 `youtube_oembed_unreachable`.
 *
 * `ctx` (userId, ipAddress) is accepted for contract parity with Reddit
 * (which uses it for the per-user cap), but YouTube's oEmbed is keyless +
 * uncounted on the operator pool — the values are intentionally unused.
 */
async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  _ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  let result;
  try {
    result = await fetchYoutubeOembed(canonicalUrl);
  } catch (err) {
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }
  if (result.kind === "private") return { kind: "private" };
  if (result.kind === "unavailable") return { kind: "unavailable" };
  return {
    kind: "ok",
    title: result.data.title,
    authorName: result.data.authorName,
    authorUrl: result.data.authorUrl,
    thumbnailUrl: result.data.thumbnailUrl,
  };
}

/**
 * validateEventInput — youtube_video URL-required validation. Throws
 * AppError 422 on invalid input.
 */
function validateEventInput(input: { kind: string; url?: string | null }): void {
  if (input.kind !== "youtube_video") return;
  if (!input.url) {
    throw new AppError("url is required when kind=youtube_video", "kind_url_inconsistent", 422, {
      reason: "youtube_video_requires_url",
    });
  }
  // Use the registry's url-router parser (ParsedUrl) instead of parseYoutubeUrl
  // (ParsedYoutubeUrl with channelId/videoId/handle discriminator). For
  // event-input validation we want "is this a youtube_video URL" — a video,
  // shorts, embed, or live URL. The handler-side `youtubeParseUrl` from
  // ./url.js is the right shape (kind: "youtube_video", externalId, ...).
  const parsed = youtubeParseUrl(input.url);
  if (parsed === null || parsed.kind !== "youtube_video") {
    throw new AppError("url is not a recognized YouTube URL", "kind_url_inconsistent", 422, {
      reason: "url_not_youtube",
    });
  }
  // Match create-path strictness. youtubeParseUrl on its own accepts any
  // non-empty path segment (e.g. /shorts/abc), so PATCH could persist a
  // malformed URL that POST would reject via
  // services/url-parser.ts:parseIngestUrl (which validates 11-char ids
  // against YOUTUBE_VIDEO_ID_RE). Re-applying the same regex here closes
  // the create-vs-update drift.
  if (!/^[\w-]{11}$/.test(parsed.externalId)) {
    throw new AppError(
      "youtube video id must be exactly 11 alphanumeric characters",
      "kind_url_inconsistent",
      422,
      { reason: "youtube_video_id_shape" },
    );
  }
}

/**
 * fetchPollStateMap — youtube_videos batch lookup. Cross-source dto.ts
 * iterates allAdapters and merges results.
 *
 * youtube_videos is PUBLIC-DATA — no user_id column, identical across
 * tenants. Lookup is keyed on the PK only. The userId parameter is
 * present for contract symmetry (other source adapters may have per-user
 * poll state) but unused here.
 */
async function fetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;
  const rows = await db
    .select({
      videoId: youtubeVideos.videoId,
      publishedAt: youtubeVideos.publishedAt,
      lastPolledAt: youtubeVideos.lastPolledAt,
      lastPollStatus: youtubeVideos.lastPollStatus,
    })
    .from(youtubeVideos)
    .where(inArray(youtubeVideos.videoId, [...externalIds]));
  for (const r of rows) {
    map.set(r.videoId, {
      publishedAt: r.publishedAt,
      lastPolledAt: r.lastPolledAt,
      lastPollStatus: r.lastPollStatus,
    });
  }
  return map;
}

/**
 * registerRoutes — mounts the per-source HTTP routes. Cross-source
 * createApp() iterates allAdapters and calls registerRoutes; adding a new
 * source's preview-metadata endpoint means implementing this method on
 * the new adapter, not editing http/app.ts.
 */
function registerRoutes(app: Hono<AdapterAppContext>): void {
  app.route("/api", youtubeMetadataRoutes);
}

/**
 * fetchSyncStats — synchronous stats fetch on manual event paste so
 * /feed shows view/like counts immediately. Calls videos.list (1 unit,
 * charged to user pool via pollStatsByVideoId), writes a
 * youtube_video_snapshots row.
 *
 * Cache-row prerequisite: writeSnapshot's UPDATE youtube_videos
 * needs a row to UPDATE. That row is UPSERTed by handleVideoSingle
 * in the enrichFromUrl preview path BEFORE this function ever runs
 * — without it, the UPDATE is a no-op and last_polled_at /
 * channel_id / published_at never land. Paste flow always passes
 * through enrichFromUrl first (the form's Fetch button hits the
 * preview endpoint).
 *
 * Returns null on rate-limited / auth-error / not-found — caller
 * (createEventFromPaste) treats as «stats unavailable now, will be
 * picked up by next active/cold cron tick».
 */
async function fetchSyncStats(
  externalId: string,
  ctx: { userId: string },
): Promise<{ viewCount: number; likeCount: number; commentCount: number } | null> {
  if (!hasYoutubeApiKeys()) return null;
  const permit = await reserveYoutubeQuota({ origin: "user", units: 1 });
  if (permit === null) return null;
  const quotaUser = youtubeQuotaUser(ctx.userId);
  const snapshots = await youtubeChannelAdapterCore
    .pollStatsByVideoId([externalId], quotaUser, permit)
    .catch(() => [] as Awaited<ReturnType<typeof youtubeChannelAdapterCore.pollStatsByVideoId>>);
  const snap = snapshots[0];
  if (!snap || snap.status !== "ok" || !snap.metrics) return null;
  const viewCount = snap.metrics.view_count ?? 0;
  const likeCount = snap.metrics.like_count ?? 0;
  const commentCount = snap.metrics.comment_count ?? 0;
  await writeSnapshot({
    videoId: externalId,
    metrics: { view_count: viewCount, like_count: likeCount, comment_count: commentCount },
    apiKeyId: permit.apiKeyId,
    unitsUsed: 0,
    poolKind: "user",
    status: "ok",
  });
  // Write audit row so the per-user cap counter sees this fetch. DB quota
  // reservation protects the operator pool, but the user cap is audit-log
  // based. Flow=stats_refresh matches the queued refresh-now semantic.
  await writeAudit({
    userId: ctx.userId,
    action: "event.poll_refreshed",
    ipAddress: "0.0.0.0",
    metadata: {
      external_id: externalId,
      kind: "youtube_video",
      platform: "youtube_channel",
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });
  return { viewCount, likeCount, commentCount };
}

async function canRunSyncStats(): Promise<AdapterCapabilityGuardResult> {
  const throttle = await getThrottleState();
  if (throttle !== "ninetyfive") {
    return { action: "run" };
  }
  return {
    action: "skip",
    reason: "youtube quota at 95%",
    retryAfterMs: msUntilMidnightPacific(),
  };
}

async function canRunRefreshNow(ctx: {
  eventId?: string;
  externalId: string;
}): Promise<AdapterCapabilityGuardResult> {
  const throttle = await canRunSyncStats();
  if (throttle.action === "skip") return throttle;

  const [videoRow] = await db
    .select({ publishedAt: youtubeVideos.publishedAt })
    .from(youtubeVideos)
    .where(eq(youtubeVideos.videoId, ctx.externalId))
    .limit(1);
  if (!videoRow || videoRow.publishedAt === null) {
    return {
      action: "skip",
      reason: "video metadata not yet available; backfill in progress",
      code: "pending_backfill",
      status: 422,
      metadata: {
        event_id: ctx.eventId,
        external_id: ctx.externalId,
      },
    };
  }

  return { action: "run" };
}

/**
 * enqueueRefreshNow — adapter-driven Refresh-Now enqueue for YouTube.
 *
 * Inserts a row into adapter_refresh_queue:youtube_channel:user_video. The SQL worker
 * claims up to 50 rows globally and makes one videos.list call. Per-user
 * quota accounting has already happened at the endpoint before enqueue.
 *
 * requestRefreshPoll already atomically stamps last_user_refresh_at and
 * enforces the 5-minute cooldown, so this enqueue path does not need a
 * second singleton/dedup layer.
 */
async function enqueueRefreshNow(input: {
  eventId: string;
  userId: string;
  externalId: string;
  eventKind: EventKind;
  tx?: DbOrTx;
}): Promise<{ queue: string; jobId: string | null }> {
  const dbCtx = input.tx ?? db;
  const [row] = await dbCtx
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "youtube_channel",
      queueName: "user_video",
      type: "video_stats",
      payload: {
        event_id: input.eventId,
        video_id: input.externalId,
        kind: input.eventKind,
        flow: "refresh-now",
      },
      userId: input.userId,
      priority: -10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return {
    queue: adapterRefreshQueueLabel("youtube_channel", "user_video"),
    jobId: row ? String(row.id) : null,
  };
}

/**
 * quotaCounters — declares youtube_metadata_fetches_per_day. Cross-source
 * services/quota.ts iterates allAdapters[*].observability.quotaCounters;
 * adding a new source's counters means declaring them on the new
 * adapter, not editing the quota.ts switch.
 */
const youtubeQuotaCounters: ReadonlyArray<AdapterQuotaCounter> = [
  {
    kind: "youtube_metadata_fetches_per_day",
    async count(dbCtx: DbOrTx, userId: string, since: Date): Promise<number> {
      const [r] = await dbCtx
        .select({ c: count() })
        .from(youtubeMetadataFetchLog)
        .where(
          and(
            eq(youtubeMetadataFetchLog.userId, userId),
            gte(youtubeMetadataFetchLog.fetchedAt, since),
          ),
        );
      return Number(r?.c ?? 0);
    },
  },
];

// youtubeAdapter — composes the per-source adapter cross-source code sees.
//
// adapter.ts exports `youtubeChannelAdapterCore` with YouTube-local upstream
// methods; those are not part of SourceAdapter. This barrel is the SINGLE composition point: it
// adds infrastructure-touching methods (registerQueues /
// scheduleCronTicks / backfillSource) and cross-source hooks
// (canonicalize, onSourceCreated, fetchEventPreviewMetadata,
// validateEventInput, fetchPollStateMap, refreshQueue, registerRoutes) plus extends
// observability with per-source quotaCounters.
//
/**
 * resetWalkerStateOnWidening — fired by cross-source updateSource when a
 * user widens `backfillTargetSince` past the prior value. Enqueues a
 * one-shot force-deep walk through the same outbox path the
 * refresh-content button uses; per-user fair-share cap is enforced here
 * so a user who already hit their daily cap can't sneak around it by
 * PATCHing the source. The trigger user pays quota; other subscribers
 * free-ride on the channel-wide fan-out.
 *
 * Pre-existing maybeEnqueueForceDeepWalk logic moved here so cross-source
 * code stays adapter-agnostic. Same skip predicates: missing state /
 * incomplete / target already deeper than backfill_oldest_at all no-op.
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
  if (source.kind !== "youtube_channel" || source.channelId === null) return;

  // updateSource already gates on patch.backfillTargetSince <
  // existing.backfillTargetSince, but defend-in-depth here lets future
  // call paths reuse the hook without re-implementing the predicate.
  if (ctx.previousTarget !== null && ctx.newTarget.getTime() >= ctx.previousTarget.getTime()) {
    return;
  }
  const state = await getChannelState("youtube_channel", source.channelId);
  if (!state) return;
  if (state.backfillComplete !== true) return;
  if (state.backfillOldestAt === null) return;
  if (ctx.newTarget.getTime() >= state.backfillOldestAt.getTime()) return;

  // Per-user fair-share cap check — mirrors refresh-content's gate so
  // PATCH widening cannot bypass the daily request/events cap.
  const cap = youtubeChannelAdapterCore.observability.userQuotaCap;
  if (cap?.requestsPerDay !== undefined || cap?.eventsPerDay !== undefined) {
    const used = await getUserQuotaUsedToday(ctx.triggerUserId, "youtube_channel");
    const resetAt = nextPacificMidnight();
    const resetInSeconds = Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000));
    if (cap.requestsPerDay !== undefined && used.requests >= cap.requestsPerDay) {
      throw new AppError(
        `daily request quota exhausted: ${used.requests}/${cap.requestsPerDay}`,
        "requests_quota_exhausted",
        429,
        { cap: cap.requestsPerDay, used: used.requests, reset_in_seconds: resetInSeconds },
      );
    }
    if (cap.eventsPerDay !== undefined && used.events >= cap.eventsPerDay) {
      throw new AppError(
        `daily events quota exhausted: ${used.events}/${cap.eventsPerDay}`,
        "events_quota_exhausted",
        429,
        { cap: cap.eventsPerDay, used: used.events, reset_in_seconds: resetInSeconds },
      );
    }
  }

  await enqueueViaOutbox(
    ctx.tx,
    QUEUES.YOUTUBE_BACKFILL_CHANNEL,
    {
      kind: "youtube_channel" as const,
      channelKey: source.channelId,
      triggerUserId: ctx.triggerUserId,
      depthBoundIso: ctx.newTarget.toISOString(),
      flow: "historical" as const,
      forceDeep: true,
    },
    {
      // Include target in the singleton key so back-to-back widens with
      // different targets each get their own pg-boss job (the key
      // dedupes in-flight queued+active jobs only).
      singletonKey: `force-deep-${source.channelId}-${ctx.triggerUserId}-${ctx.newTarget.getTime()}`,
      priority: 1,
    },
  );
}

// TypeScript guarantees completeness — the `SourceAdapter & typeof core`
// annotation fails the build if any contract method is missing from the
// spread.
export const youtubeAdapter: SourceAdapter & typeof youtubeChannelAdapterCore = {
  ...youtubeChannelAdapterCore,
  observability: {
    ...youtubeChannelAdapterCore.observability,
    quotaCounters: youtubeQuotaCounters,
  },
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canBackfillSource: canRunSyncStats,
  canonicalizeOnCreate,
  onSourceCreated,
  resetWalkerStateOnWidening,
  fetchEventPreviewMetadata,
  syncStats: {
    canRun: canRunSyncStats,
    fetch: fetchSyncStats,
  },
  validateEventInput,
  fetchPollStateMap,
  registerRoutes,
  refreshQueue: {
    canRefresh: (eventKind: EventKind): boolean => eventKind === "youtube_video",
    canRun: canRunRefreshNow,
    enqueue: enqueueRefreshNow,
  },
  workQueue: {
    scheduledWorkers: [
      {
        name: "youtube.refresh",
        intervalMs: 1000,
        readyMessage: "youtube refresh queue worker ready",
        disabledMessage: "youtube refresh queue worker disabled",
        laneQueue: {
          strategy: "fixed-slot-round-robin",
          adapterKind: "youtube_channel",
          slots: YOUTUBE_REFRESH_SLOT_MAPPING,
          fallthrough: YOUTUBE_REFRESH_FALLTHROUGH_ORDER,
          batchScope: "global",
        },
        replicaPolicy: "parallel",
        isEnabled: () => true,
        tick: youtubeRefreshQueueTick,
      },
    ],
  },
};

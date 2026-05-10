// YouTube per-source server barrel — Phase 03.0.1 D-14.
// Cross-source code (registry, worker entrypoints) imports from here.
// The internal modules (adapter, http, schema, handlers) are wired
// together inside this folder; consumers see only the adapter export.
//
// Phase 03.0.1 Plan 07 — per-kind queue topology landed (D-10..D-12).
// Queue rename map (Plan 05 → Plan 07):
//   poll.active                       → youtube.poll.cron (key=active)
//   poll.cold                         → youtube.poll.cron (key=cold)
//   poll.user                         → youtube.poll.user
//   (NEW)                             → youtube.backfill.user (Plan 10)
//   youtube.rehab_unavailable         → youtube.rehab (D-11 brevity)
//   youtube.quota_reset               → unchanged
//   youtube.channel_context_backfill  → unchanged
//
// Two scheduler.tick.* queues from Phase 03.0 Plan 09 are RETIRED here —
// collapsed into the youtube.poll.cron schedule via boss.schedule({key})
// per pg-boss v11+ multiple-schedules-per-queue. The poll-cron handler
// (./handlers/poll-cron.ts) reads job.data.tier and dispatches to
// handlePollActive / handlePollCold; the scheduler-tick → enqueue.ts hop
// is gone. Migration drizzle/0021_phase03_01_per_kind_queue_topology.sql
// cleans up the orphan pgboss.* rows.
//
// scheduleCronTicks is the REAL implementation — replaces the Plan 03
// throwing stub in ./adapter.ts. Cross-source crons (purge.daily,
// internal.healthcheck) stay in src/scheduler/index.ts because they
// apply across all sources, not just YouTube.
//
// batchSize values mirror the Phase 03.0 Plan 09 / Plan 05 contract:
//   YOUTUBE_POLL_CRON                 batchSize=4 (Active concurrency)
//   YOUTUBE_POLL_USER                 batchSize=2
//   YOUTUBE_BACKFILL_USER             batchSize=1 (Plan 10 wires the handler)
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
  AdapterPollState,
  AdapterQuotaCounter,
  BackfillWindow,
  CanonicalizeInput,
  CanonicalizeResult,
  CreateContext,
  DataSourceAdapter,
  EventPreviewMetadata,
  MinimalBoss,
  PollableSource,
  SourceCreatedHookSource,
} from "$lib/sources/adapter.js";
import type { DbOrTx } from "$lib/server/db/client.js";
import type { Hono } from "hono";
import { QUEUES } from "$lib/server/queues.js";
import { getBoss } from "$lib/server/queue-client.js";
import { youtubeChannelAdapterCore } from "./adapter.js";
import { reconcileReservoirsOnBoot } from "./http.js";
import { handlePollCron } from "./handlers/poll-cron.js";
import { handlePollUser } from "./handlers/poll-user.js";
import { handleRehabUnavailable } from "./handlers/rehab-unavailable.js";
import { handleChannelContextBackfill } from "./handlers/channel-context-backfill.js";
import { handleQuotaReset } from "./handlers/quota-reset.js";
// Phase 03.0.1 Plan 10 — youtube.backfill.user handler. Plan 07 declared the
// queue (boss.createQueue) and left the subscription comment-only since the
// handler did not yet exist; Plan 10 fills both the producer side
// (backfillSource fires boss.send into this queue) and the consumer side
// (boss.work below dispatches each job to handleBackfillUser).
import { handleBackfillUser } from "./handlers/backfill-user.js";
// Phase 03.0.1 — daily auto-backfill cron picker. Skip-gates на cron pool
// ≥50% used; enqueues backfill-user with metadata.flow='auto_passive'.
import { handleAutoBackfillCron } from "./handlers/auto-backfill-cron.js";
// Phase 03.0.1 architecture cleanup — adapter-driven create-time hooks +
// preview metadata + poll-state lookup + per-source HTTP routes. Cross-source
// services delegate via getAdapter(...) so adding Reddit (Phase 03.1) is a
// registry entry, not a 6-file edit.
import { fetchVideoMetadataByUrl } from "./metadata.js";
import { parseYoutubeUrl, youtubeParseUrl } from "./url.js";
import { fetchYoutubeOembed } from "$lib/server/integrations/youtube-oembed.js";
import { youtubeMetadataRoutes } from "./route-metadata.js";
import { youtubeVideos, youtubeMetadataFetchLog } from "./schema/index.js";
import { db } from "$lib/server/db/client.js";
import { eq, and, gte, count, inArray } from "drizzle-orm";
import { AppError } from "$lib/server/services/errors.js";
import { logger } from "$lib/server/logger.js";

async function registerQueues(boss: MinimalBoss): Promise<void> {
  // pg-boss v10+ requires createQueue before send/work — idempotent on
  // every boot. queues.ts.declareAllQueues() is still called at worker
  // bootstrap time for the cross-source roster; this function declares
  // the YouTube-specific queues again (idempotent) so the adapter's
  // registration is self-contained — Reddit/Twitter adapters follow the
  // same pattern in Phase 03.1+.
  await boss.createQueue(QUEUES.YOUTUBE_POLL_CRON);
  await boss.createQueue(QUEUES.YOUTUBE_POLL_USER);
  await boss.createQueue(QUEUES.YOUTUBE_BACKFILL_USER);
  await boss.createQueue(QUEUES.YOUTUBE_QUOTA_RESET);
  await boss.createQueue(QUEUES.YOUTUBE_REHAB);
  await boss.createQueue(QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL);
  await boss.createQueue(QUEUES.YOUTUBE_AUTO_BACKFILL_CRON);

  // youtube.poll.cron — Active+Cold collapsed via tier-tagged payload.
  // batchSize=4 matches Phase 03.0 POLL_ACTIVE concurrency (Cold's daily
  // cadence keeps it from saturating the budget regardless).
  await boss.work(QUEUES.YOUTUBE_POLL_CRON, { batchSize: 4 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollCron(
        job as { id?: string; data: { tier: "active" | "cold" } & Record<string, unknown> },
      );
    }
  });

  await boss.work(QUEUES.YOUTUBE_POLL_USER, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      await handlePollUser(job as { id: string; data: { eventId: string; userId: string } });
    }
  });

  // Phase 03.0.1 Plan 10 — youtube.backfill.user worker subscription.
  // batchSize=1 mirrors channel-context-backfill (the backfill class of
  // queues stays single-stream so two clicks on the same source don't
  // race against each other; pg-boss singletonKey on the producer side is
  // the dedup gate, this batch size is the backstop).
  await boss.work(QUEUES.YOUTUBE_BACKFILL_USER, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleBackfillUser(
        job as {
          id?: string;
          data: { sourceId: string; userId: string; origin?: "user" | "cron" };
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

  // Phase 03.0.1 — daily auto-backfill cron picker. batchSize=1 — single
  // tick per day, picks ≤50 sources, enqueues passive jobs into
  // YOUTUBE_BACKFILL_USER. Handler does the gate check (skip if pool ≥50%).
  await boss.work(QUEUES.YOUTUBE_AUTO_BACKFILL_CRON, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await handleAutoBackfillCron(job as { id: string; data: object }, boss);
    }
  });
}

/**
 * Plan 07 — REAL implementation (replaces the Plan 03 throwing stub in
 * ./adapter.ts). Registers the YouTube-specific cron schedules:
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
 * YouTube. Plan 07 src/scheduler/index.ts iterates allAdapters and calls
 * adapter.scheduleCronTicks(boss) for each per-kind set.
 *
 * Pacific-time schedules use `tz: "America/Los_Angeles"` so DST
 * transitions are handled by pg-boss; the active tier's "every 6 hours"
 * cron is left as UTC default per Phase 03.0's existing precedent
 * (operator can revisit if the time-of-day shift matters at higher
 * volumes).
 */
async function scheduleCronTicks(boss: MinimalBoss): Promise<void> {
  // Active tier — every 6 hours UTC (preserves Phase 03.0 cadence).
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
  // Phase 03.0.1 — auto-backfill picker daily 03:00 Pacific (3h after
  // quota reset at 00:00 PT — pool fresh, минимальный contention с
  // active/cold poll). Handler делает gate check (skip if pool ≥50% used)
  // и picker SELECT incomplete sources, enqueue's passive backfill jobs.
  await boss.schedule(
    QUEUES.YOUTUBE_AUTO_BACKFILL_CRON,
    "0 3 * * *",
    {},
    { tz: "America/Los_Angeles" },
  );
}

/**
 * Plan 10 — REAL backfillSource (replaces the Plan 03 throwing stub in
 * ./adapter.ts). Fire-and-forget enqueue into youtube.backfill.user via the
 * APP-role pg-boss singleton (`getBoss()` — same accessor that
 * services/data-sources.ts uses to enqueue YOUTUBE_CHANNEL_CONTEXT_BACKFILL
 * on createSource).
 *
 * singletonKey=`backfill-${source.id}` dedups concurrent clicks: two POSTs
 * to /api/sources/:id/refresh-content within the pg-boss default singleton
 * window (~5min) coalesce into one job. The second POST returns the
 * pg-boss-supplied `null` jobId — the route still emits 202 Accepted with
 * a null jobId so the user-facing button optimistically reflects success
 * (the worker only needs to run once to surface new content).
 *
 * priority=1 puts user-initiated jobs ahead of cron-initiated polls in the
 * same queue (D-09 user-pool reserve). The worker's batchSize=1 means
 * priority is the only ordering knob that matters — no concurrent mixing.
 */
async function backfillSource(
  source: PollableSource,
  ctx: AdapterContext,
): Promise<{ jobId: string | null; queue: string }> {
  const boss = await getBoss();
  const jobId = await boss.send(
    QUEUES.YOUTUBE_BACKFILL_USER,
    {
      sourceId: source.id,
      userId: source.userId,
      origin: ctx.origin,
    },
    {
      singletonKey: `backfill-${source.id}`,
      priority: 1,
    },
  );
  return { jobId, queue: QUEUES.YOUTUBE_BACKFILL_USER };
}

/**
 * Phase 03.0.1 architecture cleanup — canonicalizeOnCreate.
 * Pulls the YouTube channel/video URL canonicalization out of
 * services/data-sources.ts into the adapter. Logic preserved verbatim from
 * the prior data-sources.ts:260-292 inline switch:
 *
 *   - /channel/UC… → resolvedExternalId = channelId, canonicalize URL.
 *   - /watch?v=ID  → fetchVideoMetadataByUrl, dereference channelId, canonicalize.
 *   - /@handle, /c/, /user/ → leave as-is; worker resolves on first backfill.
 *
 * Throws AppError 422 on URLs that don't point at a YouTube
 * channel/handle/video — the same UX the inline code surfaced (the user
 * pasted youtube.com/ or localhost:5173/feed; better fail visibly).
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
 * Phase 03.0.1 architecture cleanup — onSourceCreated.
 * Pulls the YOUTUBE_CHANNEL_CONTEXT_BACKFILL enqueue out of
 * services/data-sources.ts into the adapter. Logic preserved verbatim from
 * the prior data-sources.ts:377-400 inline switch.
 *
 * Fire-and-forget: pg-boss / DB errors are logged at WARN. The created
 * source row is the load-bearing return value; backfill enqueue is a
 * nice-to-have that the user can re-trigger by re-toggling auto-import
 * (PATCH /api/sources/:id) if it ever silently fails.
 */
async function onSourceCreated(
  source: SourceCreatedHookSource,
  opts: { backfillWindow: BackfillWindow },
): Promise<void> {
  if (!source.autoImport) return;
  try {
    const boss = await getBoss();
    await boss.send(
      QUEUES.YOUTUBE_CHANNEL_CONTEXT_BACKFILL,
      {
        sourceId: source.id,
        userId: source.userId,
        handleUrl: source.handleUrl,
        backfillWindow: opts.backfillWindow,
      },
      { singletonKey: `source-${source.id}` },
    );
  } catch (err) {
    logger.warn(
      {
        sourceId: source.id,
        err: String((err as Error)?.message ?? err),
      },
      "channel-context-backfill enqueue on createSource failed; ignoring",
    );
  }
}

/**
 * Phase 03.0.1 architecture cleanup — fetchEventPreviewMetadata.
 * Pulls the YouTube oEmbed call out of services/events.ts:enrichFromUrl
 * into the adapter. Maps YoutubeOembedResult → EventPreviewMetadata so the
 * cross-source code never sees YouTube-specific result shapes.
 *
 * 5xx / network failures are caught here and translated to
 * `{kind:'unreachable'}` — cross-source enrichFromUrl maps to AppError 502
 * `youtube_oembed_unreachable` (legacy contract preserved).
 */
async function fetchEventPreviewMetadata(canonicalUrl: string): Promise<EventPreviewMetadata> {
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
 * Phase 03.0.1 architecture cleanup — validateEventInput.
 * Pulls the youtube_video URL-required validation out of services/events.ts
 * into the adapter. Throws AppError 422 on invalid input.
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
  // Phase 03.0.1 (post-review) — match create-path strictness. Pre-fix
  // youtubeParseUrl accepted any non-empty path segment (e.g. /shorts/abc),
  // so PATCH could persist a malformed URL that POST would reject via
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
 * Phase 03.0.1 architecture cleanup — fetchPollStateMap.
 * Pulls the youtube_videos batch lookup out of dto.ts into the adapter.
 * Cross-source dto.ts iterates allAdapters and merges results.
 *
 * youtube_videos is PUBLIC-DATA (CONTEXT D-07) — no user_id column,
 * identical across tenants. Lookup is keyed on the PK only. The userId
 * parameter is present for contract symmetry (Reddit/Twitter adapters
 * may have per-user poll state) but unused here.
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
 * Phase 03.0.1 architecture cleanup — registerRoutes.
 * Pulls the direct `import { youtubeMetadataRoutes }` from http/app.ts
 * into the adapter. Cross-source createApp() iterates allAdapters and
 * calls registerRoutes; adding Reddit's preview-metadata endpoint in
 * Phase 03.1 means implementing this method on the Reddit adapter, not
 * editing http/app.ts.
 */
function registerRoutes(app: Hono<AdapterAppContext>): void {
  app.route("/api", youtubeMetadataRoutes);
}

/**
 * Phase 03.0.1 architecture cleanup — quotaCounters.
 * Declares youtube_metadata_fetches_per_day. Cross-source services/quota.ts
 * iterates allAdapters[*].observability.quotaCounters; adding Reddit's
 * counters in Phase 03.1 means declaring them on the Reddit adapter, not
 * editing the quota.ts switch.
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
// Phase 03.0.1 architecture cleanup: adapter.ts exports `youtubeChannelAdapterCore`
// typed as `Pick<DataSourceAdapter, ...polling/observability/canRefreshPoll>`
// — no throwing stubs. This barrel is the SINGLE composition point: it
// adds infrastructure-touching methods (registerQueues / scheduleCronTicks /
// backfillSource) and cross-source hooks (canonicalize, onSourceCreated,
// fetchEventPreviewMetadata, validateEventInput, fetchPollStateMap,
// registerRoutes) plus extends observability with per-source quotaCounters.
//
// TypeScript guarantees completeness — the `: DataSourceAdapter` annotation
// fails the build if any contract method is missing from the spread.
export const youtubeAdapter: DataSourceAdapter = {
  ...youtubeChannelAdapterCore,
  observability: {
    ...youtubeChannelAdapterCore.observability,
    quotaCounters: youtubeQuotaCounters,
  },
  registerQueues,
  scheduleCronTicks,
  backfillSource,
  canonicalizeOnCreate,
  onSourceCreated,
  fetchEventPreviewMetadata,
  validateEventInput,
  fetchPollStateMap,
  registerRoutes,
  // Phase 03.0.1 — sync RateLimiterMemory reservoirs with persistent
  // youtube_service_quota_usage counter on worker boot. Adapter-owned hook
  // replaces the cross-source `import reconcileReservoirsOnBoot from
  // youtube/server/http.js` that worker/index.ts hardcoded pre-cleanup.
  reconcileRuntimeState: reconcileReservoirsOnBoot,
};

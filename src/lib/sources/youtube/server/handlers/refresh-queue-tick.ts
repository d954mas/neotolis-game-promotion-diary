// YouTube video stats SQL queue worker.
//
// One tick claims up to 50 rows from the selected lane and makes one
// videos.list call. Per-user fair-share is enforced before user_video
// enqueue and recorded in audit_log; service_video rows run under the cron
// pool.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { youtubeVideos } from "../schema/index.js";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterBatchLaneWorkerTickResult,
  type AdapterLaneClaimGateContext,
  type AdapterLaneClaimGateResult,
  type AdapterLaneDispatchContext,
  type AdapterLaneWorkerRow,
} from "$lib/server/services/adapter-lane-worker.js";
import { logger } from "$lib/server/logger.js";
import { youtubeChannelAdapterCore, YOUTUBE_VIDEOS_BATCH_SIZE } from "../adapter.js";
import { writeSnapshot } from "../snapshots.js";
import { durationPrefilter } from "../duration.js";
import { probeIsShort, PROBE_BUDGET_PER_TICK } from "../shorts-probe.js";
import {
  hasYoutubeApiKeys,
  msUntilMidnightPacific,
  reserveYoutubeQuota,
  type YoutubeQuotaPermit,
} from "../quota.js";

export const YOUTUBE_REFRESH_SLOT_MAPPING = ["user_video", "service_video"] as const;
export const YOUTUBE_REFRESH_FALLTHROUGH_ORDER = ["user_video", "service_video"] as const;
export type YoutubeRefreshQueueName = (typeof YOUTUBE_REFRESH_SLOT_MAPPING)[number];

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
const YOUTUBE_SERVICE_REFRESH_QUOTA_USER = "neotolis-svc-video";
// User refresh rows intentionally share one quotaUser: the upstream request
// is a cross-tenant videos.list batch, so one API unit can refresh up to 50
// videos. Tenant fairness is enforced before enqueue by refresh-poll caps and
// cooldowns; splitting this by user would spend more operator quota.
const YOUTUBE_USER_REFRESH_QUOTA_USER = "neotolis-user-refresh";

const youtubeRefreshWorker = createAdapterBatchLaneWorker({
  adapterKind: "youtube_channel",
  slots: YOUTUBE_REFRESH_SLOT_MAPPING,
  fallthrough: YOUTUBE_REFRESH_FALLTHROUGH_ORDER,
  maxAttempts: MAX_ATTEMPTS,
  maxBatchSize: YOUTUBE_VIDEOS_BATCH_SIZE,
  batchScope: "global",
  staleProcessingMs: STALE_PROCESSING_MS,
  staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
  claimGate: claimYoutubeQuotaSlot,
  dispatch: dispatchRefreshBatch,
});

export async function youtubeRefreshQueueTick(): Promise<AdapterBatchLaneWorkerTickResult> {
  return youtubeRefreshWorker.tick();
}

async function claimYoutubeQuotaSlot(
  ctx: AdapterLaneClaimGateContext<YoutubeRefreshQueueName>,
): Promise<AdapterLaneClaimGateResult<YoutubeQuotaPermit>> {
  const potentialWork = await loadVideoWork(ctx.rows, ctx.tx);
  if (potentialWork.length === 0) {
    return { action: "run" };
  }
  if (!hasYoutubeApiKeys()) return { action: "run" };
  const poolKind = ctx.queueName === "service_video" ? "cron" : "user";
  const permit = await reserveYoutubeQuota({ origin: poolKind, units: 1, tx: ctx.tx });
  if (permit === null) {
    return {
      action: "defer",
      retryAfterMs: msUntilMidnightPacific(),
      reason: `youtube ${poolKind} quota pool exhausted`,
    };
  }
  return { action: "run", permit };
}

async function dispatchRefreshBatch(
  rows: AdapterLaneWorkerRow[],
  ctx: AdapterLaneDispatchContext<YoutubeQuotaPermit>,
): Promise<void> {
  if (rows.length === 0) return;
  const videoWork = await loadVideoWork(rows);

  if (videoWork.length === 0) {
    logger.warn(
      { ids: rows.map((row) => row.id) },
      "youtube refresh queue: no live video work; marking rows done",
    );
    return;
  }

  const queueName = rows[0]!.queueName as YoutubeRefreshQueueName;
  const poolKind = queueName === "service_video" ? "cron" : "user";
  if (!ctx.permit) {
    logger.warn(
      { queueName, count: videoWork.length },
      "youtube refresh queue: SERVICE_YOUTUBE_API_KEYS empty; degrading to auth_error",
    );
    for (const item of videoWork) {
      await writeSnapshot({
        videoId: item.videoId,
        metrics: null,
        apiKeyId: "no-key",
        unitsUsed: 0,
        poolKind,
        status: "auth_error",
      });
    }
    return;
  }

  if (queueName === "service_video") {
    await refreshVideoGroup(
      [...new Set(videoWork.map((item) => item.videoId))],
      YOUTUBE_SERVICE_REFRESH_QUOTA_USER,
      poolKind,
      ctx.permit,
    );
    return;
  }

  await refreshVideoGroup(
    [...new Set(videoWork.map((item) => item.videoId))],
    YOUTUBE_USER_REFRESH_QUOTA_USER,
    poolKind,
    ctx.permit,
  );
}

async function refreshVideoGroup(
  videoIds: string[],
  quotaUser: string,
  poolKind: "cron" | "user",
  permit: YoutubeQuotaPermit,
): Promise<void> {
  if (videoIds.length === 0) return;
  const snapshots = await youtubeChannelAdapterCore.pollStatsByVideoId(videoIds, quotaUser, permit);
  const snapshotByVideoId = new Map(videoIds.map((videoId, i) => [videoId, snapshots[i]!]));

  // Shorts classification — only for videos this tick already touches whose
  // media_type is still NULL (lazy heal: existing prod rows start NULL, classify
  // as the poll worker walks them). Already-classified rows are skipped (one
  // probe per video, ever). The per-tick probe budget bounds network round-trips
  // so a large legacy NULL backlog heals across many ticks, not all at once.
  const unclassified = await loadUnclassifiedVideoIds(videoIds);
  let probeBudget = PROBE_BUDGET_PER_TICK;

  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i]!;
    const snap = snapshotByVideoId.get(videoId)!;

    // Decide the media_type verdict (undefined = leave the column untouched):
    //   - already classified (not in `unclassified`)  → undefined.
    //   - a failed poll (status !== ok)                → undefined (no signal).
    //   - duration > Shorts ceiling                    → "video" (no probe).
    //   - duration ≤ ceiling / unknown AND budget left → probe (decider).
    //   - budget exhausted                             → undefined (next tick).
    let mediaType: "short" | "video" | undefined;
    if (snap.status === "ok" && unclassified.has(videoId)) {
      const prefilter = durationPrefilter(snap.metadata?.duration_seconds ?? null);
      if (prefilter === "skip-video") {
        mediaType = "video";
      } else if (probeBudget > 0) {
        probeBudget -= 1;
        // null (ambiguous / probe failure) → leave NULL: classifies as video
        // downstream, never guessed. Heals on a future tick's probe.
        mediaType = (await probeIsShort(videoId)) ?? undefined;
      }
    }

    await writeSnapshot({
      videoId,
      metrics:
        snap.status === "ok" && snap.metrics
          ? {
              view_count: snap.metrics.view_count ?? 0,
              like_count: snap.metrics.like_count ?? 0,
              comment_count: snap.metrics.comment_count ?? 0,
            }
          : null,
      apiKeyId: permit.apiKeyId,
      unitsUsed: 0,
      poolKind,
      status: snap.status,
      mediaType,
    });
  }
}

/** The subset of `videoIds` whose youtube_videos.media_type is still NULL —
 *  the classification candidates. Public-data table (no userId scope); a video
 *  row may not exist yet (paste-only pre-backfill) and is simply absent from the
 *  result (no classification attempted until the row exists). */
async function loadUnclassifiedVideoIds(videoIds: string[]): Promise<Set<string>> {
  if (videoIds.length === 0) return new Set();
  const rows = await db
    .select({ videoId: youtubeVideos.videoId })
    .from(youtubeVideos)
    .where(and(inArray(youtubeVideos.videoId, videoIds), isNull(youtubeVideos.mediaType)));
  return new Set(rows.map((r) => r.videoId));
}

async function loadVideoWork(
  rows: readonly AdapterLaneWorkerRow[],
  dbCtx: DbOrTx = db,
): Promise<Array<{ videoId: string; userId: string | null }>> {
  const result: Array<{ videoId: string; userId: string | null }> = [];
  for (const row of rows) {
    if (row.queueName === "service_video") {
      const videoId = row.payload?.video_id;
      if (typeof videoId === "string" && videoId.length > 0) {
        result.push({ videoId, userId: null });
      }
      continue;
    }

    const eventId = row.payload?.event_id;
    if (typeof eventId !== "string" || row.userId === null) continue;
    const [event] = await dbCtx
      .select({
        id: events.id,
        userId: events.userId,
        externalId: events.externalId,
        kind: events.kind,
      })
      .from(events)
      .where(
        and(
          eq(events.id, eventId),
          eq(events.userId, row.userId),
          eq(events.kind, "youtube_video"),
          isNull(events.deletedAt),
        ),
      )
      .limit(1);
    if (!event || !event.externalId) continue;
    result.push({ videoId: event.externalId, userId: event.userId });
  }
  return result;
}

export function __resetYoutubeRefreshQueueWorkerForTest(): void {
  youtubeRefreshWorker.resetForTest();
}

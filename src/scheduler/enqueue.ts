// Phase 3.0 Plan 09 + post-build refactor (2026-05-06) — scheduler enqueue logic.
//
// The scheduler is the SINGLE process that decides "what's due to poll".
// Workers consume jobs blind — they trust the videoIds payload and run.
// This module owns the SQL window + tier-resolver gate + throttle gate.
//
// Per-video refactor (2026-05-06): the scheduler now operates on UNIQUE
// video_id-s (not per-event ids). With multiple events for the same
// external_id (one user logging "Released X" + "Promo stream for X" + ...,
// or different users referencing the same upstream video), the old per-
// event model issued duplicate HTTP for one upstream entity. The new model:
//
//   1. SELECT DISTINCT external_id FROM events JOIN youtube_videos.
//      Tier filter is published_at (the video's age), not occurred_at (the
//      event's age) — a "I logged a promo today for a year-old video"
//      paste correctly resolves to Cold/Frozen, not Active.
//   2. Auto-import gate stays — events with source_id NOT NULL require
//      data_sources.auto_import=true on the parent. Manual paste (source_id
//      IS NULL) is always pollable.
//   3. Job payload is { videoIds }. Workers issue ONE HTTP per ≤50-id batch
//      with quotaUser="neotolis-svc-active" (or "-cold") — no per-user
//      attribution since one HTTP serves all tenants who reference each
//      video.
//
// Pitfall 7 (single source of truth): tier classification flows through
// resolveTier() — never re-derive the 24h / 28d / Unavailable boundaries
// here. The SQL filter is a coarse first-cut (date arithmetic on
// published_at + last_polled_at); the JS filter via resolveTier is the
// authoritative classification.
//
// Throttle gate (Pattern 4):
//   - At getThrottleState() === 'eighty':
//       Cold + auto-import paused; Active continues.
//   - At getThrottleState() === 'ninetyfive':
//       Cold + Active paused; refresh-now (poll.user, set by route
//       layer in services/refresh-poll.ts) continues regardless.

import { sql, and, gt, isNotNull, isNull, lte, eq, inArray } from "drizzle-orm";
import { db } from "../lib/server/db/client.js";
import { events } from "../lib/server/db/schema/events.js";
import { dataSources } from "../lib/server/db/schema/data-sources.js";
import { youtubeVideos } from "../lib/server/db/schema/youtube-videos.js";
import {
  resolveTier,
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
  UNAVAILABLE_POLL_STATUSES,
} from "../lib/server/services/tier-resolver.js";
import {
  getThrottleState,
  markThrottleTransition,
  THROTTLE_EIGHTY_THRESHOLD,
} from "../lib/server/services/youtube-quota-tracker.js";
import { QUEUES } from "../lib/server/queues.js";
import { getBoss } from "../lib/server/queue-client.js";
import { logger } from "../lib/server/logger.js";

const ENQUEUE_BATCH_SIZE = 50;

interface EnqueueResult {
  throttleState: string;
  skipped: boolean;
  jobsEnqueued: number;
  /** Number of unique videoIds covered across all enqueued jobs. */
  videosCovered: number;
}

/**
 * Internal helper — resolve which video_ids are eligible to poll for a tier.
 *
 * Returns the de-duplicated list of external_ids whose:
 *   - youtube_videos.published_at falls in the (cutoffOldest, cutoffNewest] window
 *   - youtube_videos.last_poll_status is NOT in the unavailable override list
 *   - at least one referencing event is alive (not soft-deleted) and either
 *     source_id IS NULL (manual paste — always pollable) or its source has
 *     auto_import=true.
 *
 * The JS-side resolveTier() pass is the authoritative classifier; the SQL
 * filter is the coarse window. Pitfall 7 — never inline a tier boundary.
 */
async function selectEligibleVideoIds(
  cutoffNewest: Date | null,
  cutoffOldest: Date,
  expectedTier: "active" | "cold",
  now: Date,
): Promise<string[]> {
  // Fetch candidate (external_id, published_at, last_poll_status, source_id)
  // tuples in one JOIN. The eslint-disable is the same fan-out rationale as
  // the prior per-event scheduler — this is the cron tick that builds work
  // across all tenants. Per-video writeSnapshot downstream is public-data,
  // not tenant-scoped (writeSnapshot's UPDATE keys on video_id only).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design (Plan 03.0-09 §"scheduler tick" — one cron tick batches eligible videos across ALL tenants into POLL_ACTIVE/COLD jobs). Per-video writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({
      videoId: youtubeVideos.videoId,
      publishedAt: youtubeVideos.publishedAt,
      lastPollStatus: youtubeVideos.lastPollStatus,
      sourceId: events.sourceId,
    })
    .from(events)
    .innerJoin(youtubeVideos, eq(events.externalId, youtubeVideos.videoId))
    .where(
      and(
        sql`${events.kind} = 'youtube_video'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        isNotNull(youtubeVideos.publishedAt),
        cutoffNewest ? lte(youtubeVideos.publishedAt, cutoffNewest) : sql`true`,
        gt(youtubeVideos.publishedAt, cutoffOldest),
      ),
    );

  // Authoritative tier classification on the JS side. SQL window is a
  // superset (it does not know about UNAVAILABLE_POLL_STATUSES override).
  const tierMatched = rows.filter(
    (r) => resolveTier(r.publishedAt, r.lastPollStatus, now) === expectedTier,
  );

  // Auto-import gate: events with source_id NOT NULL require their parent
  // data_source's auto_import=true. Manual paste (source_id IS NULL) is
  // always pollable. Note: the JOIN above produces (video_id, source_id)
  // pairs — the SAME video might appear with multiple source_id values
  // (one user pasted manually, another added via auto_import source).
  // We dedup AFTER the auto-import check: if ANY event references this
  // video on a permitted path (manual OR auto-import-enabled source), the
  // video is eligible.
  const sourceIds = Array.from(
    new Set(tierMatched.map((r) => r.sourceId).filter((s): s is string => s !== null)),
  );
  const autoImportSourceIds = new Set<string>();
  if (sourceIds.length > 0) {
    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out, sources lookup batched for the candidate video set.
    const sourceRows = await db
      .select({ id: dataSources.id, autoImport: dataSources.autoImport })
      .from(dataSources)
      .where(and(inArray(dataSources.id, sourceIds), isNull(dataSources.deletedAt)));
    for (const s of sourceRows) {
      if (s.autoImport) autoImportSourceIds.add(s.id);
    }
  }

  const eligibleVideos = new Set<string>();
  for (const r of tierMatched) {
    if (r.sourceId === null || autoImportSourceIds.has(r.sourceId)) {
      eligibleVideos.add(r.videoId);
    }
  }
  return Array.from(eligibleVideos);
}

/**
 * Active-tier scheduled poll (every 6 hours UTC default — see scheduler/index.ts).
 *
 * Picks unique video_ids whose youtube_videos.published_at < 24h ago.
 * Throttle gate: pauses at ninetyfive only. eighty leaves Active running
 * (the user-time-budget protection only kicks in at the hard ceiling).
 */
export async function enqueueActivePolls(now: Date = new Date()): Promise<EnqueueResult> {
  const throttle = await getThrottleState(now);
  if (throttle === "ninetyfive") {
    logger.info({ throttle }, "scheduler skip Active — quota at 95%");
    return { throttleState: throttle, skipped: true, jobsEnqueued: 0, videosCovered: 0 };
  }
  if (throttle === "eighty") {
    try {
      await markThrottleTransition({
        state: "eighty",
        apiKeyId: "scheduler-tick",
        estimatedUnits: THROTTLE_EIGHTY_THRESHOLD,
      });
    } catch (err) {
      logger.warn({ err }, "scheduler: markThrottleTransition (eighty) failed");
    }
  }

  const cutoff = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const eligibleVideoIds = await selectEligibleVideoIds(null, cutoff, "active", now);

  if (eligibleVideoIds.length === 0) {
    return { throttleState: throttle, skipped: false, jobsEnqueued: 0, videosCovered: 0 };
  }

  const boss = await getBoss();
  let jobsEnqueued = 0;
  for (let i = 0; i < eligibleVideoIds.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = eligibleVideoIds.slice(i, i + ENQUEUE_BATCH_SIZE);
    await boss.send(
      QUEUES.POLL_ACTIVE,
      { videoIds: batch },
      {
        singletonKey: `active-${now.toISOString().slice(0, 16)}-${i}`,
      },
    );
    jobsEnqueued += 1;
  }
  logger.info(
    { throttle, jobsEnqueued, videosCovered: eligibleVideoIds.length },
    "scheduler enqueueActivePolls: sent batches to POLL_ACTIVE",
  );
  return {
    throttleState: throttle,
    skipped: false,
    jobsEnqueued,
    videosCovered: eligibleVideoIds.length,
  };
}

/**
 * Cold-tier scheduled poll (once per day at 5 AM UTC — see scheduler/index.ts).
 *
 * Picks unique video_ids whose youtube_videos.published_at is between
 * (now - 28d) and (now - 24h). Throttle gate: pauses at eighty AND
 * ninetyfive — Cold is the first thing to give up on heavy days.
 */
export async function enqueueColdPolls(now: Date = new Date()): Promise<EnqueueResult> {
  const throttle = await getThrottleState(now);
  if (throttle !== "ok") {
    logger.info({ throttle }, "scheduler skip Cold — quota throttled");
    return { throttleState: throttle, skipped: true, jobsEnqueued: 0, videosCovered: 0 };
  }

  const activeCutoff = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const coldCutoff = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
  const eligibleVideoIds = await selectEligibleVideoIds(activeCutoff, coldCutoff, "cold", now);

  if (eligibleVideoIds.length === 0) {
    return { throttleState: throttle, skipped: false, jobsEnqueued: 0, videosCovered: 0 };
  }

  const boss = await getBoss();
  let jobsEnqueued = 0;
  for (let i = 0; i < eligibleVideoIds.length; i += ENQUEUE_BATCH_SIZE) {
    const batch = eligibleVideoIds.slice(i, i + ENQUEUE_BATCH_SIZE);
    await boss.send(
      QUEUES.POLL_COLD,
      { videoIds: batch },
      {
        singletonKey: `cold-${now.toISOString().slice(0, 13)}-${i}`,
      },
    );
    jobsEnqueued += 1;
  }
  logger.info(
    { throttle, jobsEnqueued, videosCovered: eligibleVideoIds.length },
    "scheduler enqueueColdPolls: sent batches to POLL_COLD",
  );
  return {
    throttleState: throttle,
    skipped: false,
    jobsEnqueued,
    videosCovered: eligibleVideoIds.length,
  };
}

// Suppress unused-import false positive — UNAVAILABLE_POLL_STATUSES is
// referenced via resolveTier internals; keeping the explicit import here
// makes the override list visible at the scheduler entry point for code
// readers without forcing a re-export from tier-resolver.
void UNAVAILABLE_POLL_STATUSES;

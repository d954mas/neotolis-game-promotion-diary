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

import {
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "../lib/server/services/tier-resolver.js";
import {
  getThrottleState,
  markThrottleTransition,
  THROTTLE_EIGHTY_THRESHOLD,
} from "../lib/server/services/youtube-quota-tracker.js";
import { selectEligibleVideoIds } from "../lib/server/services/poll-eligibility.js";
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
        // Scheduler-tick context: the 80% threshold was detected via the
        // aggregate cross-key counter, not a per-key 4xx response. We have
        // no specific apiKeyId to attribute — omit the field rather than
        // emit a synthetic "scheduler-tick" placeholder. The audit row
        // still lands; only metadata.api_key_id is absent.
        state: "eighty",
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

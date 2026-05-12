// Cold-tier poll handler.
//
// Identical pipeline shape to poll-active.ts (see that file's header).
// Differentiation is at the CONFIGURATION level:
//   - Tier window: 24h <= age < 28d (vs. age < 24h for Active).
//   - Throttle gate: skip on BOTH 'eighty' AND 'ninetyfive'. Cold is the
//     first thing to give up on heavy days. (Active runs through 'eighty'.)
//   - quotaUser: "neotolis-svc-cold" (distinct from -active so Google's
//     burst-shaper buckets the two ticks separately — they should never
//     overlap in time, but a constant-string fingerprint per tier is the
//     cleanest contract).
//
// Why two handlers if the logic is identical-shaped? Configuration density
// + cron frequency + concurrency cap. Cold queue is shaped for a once-daily
// sweep at low concurrency (batchSize=1) so it cannot starve Active queue's
// 6-hour budget. A unified handler would still need queue-aware concurrency
// caps + tier-keyed quotaUser; the duplication makes the topology obvious
// in the per-source server barrel.
//
// Active and Cold share one queue (youtube.poll.cron) with a key-based
// schedule split (boss.schedule(...,{key:"active"|"cold"}) per pg-boss
// v11+). The poll-cron dispatcher (./poll-cron.ts) reads job.data.tier
// and routes to handlePollActive or handlePollCold.
//
// Per-user cap audit: same as poll-active — this handler does NOT write
// audit_log. Cron-driven cold polls consume the operator pool, not any
// user's daily fair-share cap. User-cap audit for refresh-now flows is
// written at endpoint enqueue time (services/refresh-poll.ts).

import {
  TIER_BOUNDARY_ACTIVE_MS,
  TIER_BOUNDARY_COLD_MS,
} from "$lib/server/services/tier-resolver.js";
import { selectEligibleVideoIds } from "$lib/server/services/poll-eligibility.js";
import {
  youtubeChannelAdapterCore as youtubeChannelAdapter,
  YOUTUBE_VIDEOS_BATCH_SIZE,
} from "../adapter.js";
import { writeSnapshot } from "../snapshots.js";
import { pickKeyForJob, markThrottleTransition, getThrottleState } from "../quota.js";
import { logger } from "$lib/server/logger.js";

const QUOTA_USER_COLD = "neotolis-svc-cold";

/**
 * Cold-tier poll handler — fed by youtube.poll.cron (key=cold) directly.
 *
 * Job shape: `{ id?, data: { tier: "cold" } }`.
 */
export async function handlePollCold(job: {
  id?: string;
  data: { tier: "cold" } & Record<string, unknown>;
}): Promise<void> {
  // Throttle gate — skip Cold on BOTH 'eighty' and 'ninetyfive'.
  const now = new Date();
  const throttle = await getThrottleState(now);
  if (throttle !== "ok") {
    logger.info(
      { jobId: job.id, throttle, tier: "cold" },
      "youtube.poll.cron tier=cold: skip — quota throttled",
    );
    return;
  }

  // Tier-eligibility: 24h <= published_at age < 28d. cutoffNewest is the
  // 24h boundary (active/cold split); cutoffOldest is 28d (cold/frozen
  // split). resolveTier() applies the JS-side authoritative
  // classification. Never inline the boundary literals — keep them in
  // tier-resolver as the single source of truth.
  const cutoffNewest = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const cutoffOldest = new Date(now.getTime() - TIER_BOUNDARY_COLD_MS);
  const videoIds = await selectEligibleVideoIds(cutoffNewest, cutoffOldest, "cold", now);
  if (videoIds.length === 0) {
    logger.debug(
      { jobId: job.id, tier: "cold", count: 0 },
      "youtube.poll.cron tier=cold: no eligible videos",
    );
    return;
  }

  // Pre-resolve and thread through (see PickedKey jsdoc on
  // $lib/sources/adapter.ts) — keeps the worker's quota row keyed under
  // the same apiKeyId the adapter actually used for the HTTP.
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: videoIds.length, tier: "cold" },
      "poll-cold: SERVICE_YOUTUBE_API_KEYS empty; videos will degrade to auth_error",
    );
    for (const videoId of videoIds) {
      try {
        await writeSnapshot({
          videoId,
          metrics: null,
          apiKeyId: "no-key",
          unitsUsed: 0,
          // Cold-tier polls are scheduler-driven → cron pool.
          poolKind: "cron",
          status: "auth_error",
        });
      } catch (err) {
        logger.error(
          { jobId: job.id, videoId, err },
          "poll-cold: writeSnapshot threw on no-key path; continuing",
        );
      }
    }
    return;
  }

  // Step A — HTTP (OUTSIDE any tx).
  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(
    videoIds,
    QUOTA_USER_COLD,
    picked,
  );

  // Step B — writeSnapshot per result. Quota cost: pollStatsByVideoId
  // chunks input into batches of YOUTUBE_VIDEOS_BATCH_SIZE (50, Google's
  // videos.list cap) — each chunk = 1 quota unit. Charge on the first
  // video of every chunk (i % 50 === 0); rest pass unitsUsed=0. Per
  // Google's quota guide ("all API requests, including invalid requests,
  // incur at least a one-point quota cost"), auth_error / non-2xx
  // outcomes still consume the unit because the request reached YouTube.
  // The no-key path returns BEFORE this loop.
  let rateLimitedSeen = false;
  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i]!;
    const snap = snapshots[i]!;
    const unitsThisVideo = i % YOUTUBE_VIDEOS_BATCH_SIZE === 0 ? 1 : 0;
    try {
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
        apiKeyId: picked.apiKeyId,
        unitsUsed: unitsThisVideo,
        // Cold-tier polls are scheduler-driven → cron pool.
        poolKind: "cron",
        status: snap.status,
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, videoId, err },
        "poll-cold: writeSnapshot threw; continuing batch",
      );
    }
    if (snap.status === "rate_limited") rateLimitedSeen = true;
  }

  if (rateLimitedSeen) {
    try {
      await markThrottleTransition({
        state: "ninetyfive",
        apiKeyId: picked.apiKeyId,
        estimatedUnits: 9500,
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err }, "poll-cold: markThrottleTransition failed");
    }
  }

  logger.info(
    { jobId: job.id, tier: "cold", count: snapshots.length },
    "youtube.poll.cron tier=cold: snapshots written",
  );
}

// Active-tier poll handler.
//
// The youtube.poll.cron cron schedule fires with `{ tier: "active" }`
// payload (via boss.schedule key=active per pg-boss v11+
// multiple-schedule-per-queue). The poll-cron dispatcher (./poll-cron.ts)
// calls handlePollActive with that tier-tagged job. handlePollActive
// internally enumerates eligible videos AND runs the two-phase
// HTTP+writeSnapshot pipeline.
//
// Throttle gate: skip-on-ninetyfive, no-skip-on-eighty. Lives in this
// handler alongside the tier-eligibility computation.
//
// Per-video discipline: stats polling is per-video — the scheduler keys
// on youtube_videos.published_at (the video's age), not events.occurred_at.
// One videos.list call serves up to 50 ids regardless of how many tenants
// reference each video.
//
// Two-step tx pattern (pinned by tests/integration/poll-worker-tx-boundary.test.ts):
//   A. Step A — single batched HTTP via pollStatsByVideoId(...) OUTSIDE
//      any tx. Adapter handles the ≤50-id boundary, error mapping,
//      Shorts detection, and the quotaUser fairness param.
//   B. Step B — writeSnapshot per video result, each in its OWN short tx
//      (snapshot INSERT + youtube_videos UPDATE + quota UPSERT). Tx-
//      boundary < 50ms regardless of upstream YouTube latency.
//
// quotaUser fingerprint: constant `"neotolis-svc-active"` (not per-user).
// Service-driven polls span all tenants; one HTTP serves N tenants
// referencing the same video.
//
// Auth gate: pickKeyForJob() returns null if SERVICE_YOUTUBE_API_KEYS is
// empty. The no-key path still runs through the worker — for every
// eligible video we writeSnapshot status='auth_error' so
// youtube_videos.last_polled_at advances and the tier resolver
// classifies the video as Unavailable on subsequent ticks.
//
// Throttle transition: when the adapter returns status='rate_limited' for any
// video, we call markThrottleTransition({state:'ninetyfive'}) — first signal
// that the YouTube quota wall has been hit, even though the quota tracker's
// running counter may not yet show 9500.
//
// Per-user cap audit: this handler does NOT write audit_log directly. Stats
// quota is tracked in youtube_service_quota_usage via writeSnapshot's UPSERT
// (operator-side counter). The user-cap counter for stats refreshes (flow=
// 'stats_refresh') is written at endpoint enqueue time in
// services/refresh-poll.ts (cap-counted user action: «I clicked Refresh
// now»). The cron-driven Active/Cold tier polls themselves are operator-pool
// work — they do NOT count against any user's daily fair-share cap.

import { TIER_BOUNDARY_ACTIVE_MS } from "$lib/server/services/tier-resolver.js";
import { selectEligibleVideoIds } from "$lib/server/services/poll-eligibility.js";
import {
  youtubeChannelAdapterCore as youtubeChannelAdapter,
  YOUTUBE_VIDEOS_BATCH_SIZE,
} from "../adapter.js";
import { writeSnapshot } from "../snapshots.js";
import {
  pickKeyForJob,
  markThrottleTransition,
  getThrottleState,
  THROTTLE_EIGHTY_THRESHOLD,
} from "../quota.js";
import { logger } from "$lib/server/logger.js";

const QUOTA_USER_ACTIVE = "neotolis-svc-active";

/**
 * Active-tier poll handler — fed by youtube.poll.cron (key=active) directly.
 *
 * Job shape: `{ id?, data: { tier: "active" } }`. The cron schedule sends
 * `{ tier: "active" }` payloads via boss.schedule(...,{key:"active"});
 * see src/lib/sources/youtube/server/index.ts.scheduleCronTicks.
 */
export async function handlePollActive(job: {
  id?: string;
  data: { tier: "active" } & Record<string, unknown>;
}): Promise<void> {
  // Throttle gate — pause Active tier at ninetyfive (the hard ceiling).
  // 'eighty' lets Active continue (only Cold pauses there).
  const now = new Date();
  const throttle = await getThrottleState(now);
  if (throttle === "ninetyfive") {
    logger.info(
      { jobId: job.id, throttle, tier: "active" },
      "youtube.poll.cron tier=active: skip — quota at 95%",
    );
    return;
  }
  if (throttle === "eighty") {
    try {
      await markThrottleTransition({
        // Cron tick context — no specific apiKeyId to attribute (the
        // 80% threshold was crossed via the aggregate cross-key counter).
        state: "eighty",
        estimatedUnits: THROTTLE_EIGHTY_THRESHOLD,
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err }, "poll-active: markThrottleTransition (eighty) failed");
    }
  }

  // Tier-eligibility: published_at within the active window (age < 24h).
  // resolveTier() applies the JS-side authoritative classification (the
  // SQL window is a coarse first-cut). Never inline the boundary
  // literals; reuse TIER_BOUNDARY_ACTIVE_MS.
  const cutoffOldest = new Date(now.getTime() - TIER_BOUNDARY_ACTIVE_MS);
  const videoIds = await selectEligibleVideoIds(null, cutoffOldest, "active", now);
  if (videoIds.length === 0) {
    logger.debug(
      { jobId: job.id, tier: "active", count: 0 },
      "youtube.poll.cron tier=active: no eligible videos",
    );
    return;
  }

  // Pre-resolve the API key for this batch and thread it through the
  // adapter — see PickedKey jsdoc on $lib/sources/adapter.ts. With one key
  // in env this matches the previous behavior; with N≥2 keys this is the
  // load-bearing fix that keeps the youtube_service_quota_usage row keyed
  // under the same apiKeyId the adapter actually used for the HTTP.
  const picked = pickKeyForJob();
  if (!picked) {
    // env.SERVICE_YOUTUBE_API_KEYS empty — short-circuit to auth_error
    // snapshots without invoking the adapter. Self-host parity: a self-
    // hoster who never sets the env var gets a graceful no-op rather than
    // an exception.
    logger.warn(
      { jobId: job.id, batchSize: videoIds.length, tier: "active" },
      "poll-active: SERVICE_YOUTUBE_API_KEYS empty; videos will degrade to auth_error",
    );
    for (const videoId of videoIds) {
      try {
        await writeSnapshot({
          videoId,
          metrics: null,
          apiKeyId: "no-key",
          unitsUsed: 0,
          // Active-tier polls are scheduler-driven → cron pool.
          poolKind: "cron",
          status: "auth_error",
        });
      } catch (err) {
        logger.error(
          { jobId: job.id, videoId, err },
          "poll-active: writeSnapshot threw on no-key path; continuing",
        );
      }
    }
    return;
  }

  // Step A — HTTP call (OUTSIDE any tx). The adapter handles the ≤50-id
  // boundary, error mapping, Shorts detection, and the quotaUser fairness
  // param. Returns StatsSnapshot[] aligned to input order.
  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(
    videoIds,
    QUOTA_USER_ACTIVE,
    picked,
  );

  // Step B — writeSnapshot per result. Each call opens its own short tx
  // (snapshot INSERT ON CONFLICT DO NOTHING + youtube_videos UPDATE +
  // quota UPSERT chained). On rate_limited from the adapter, mark the
  // throttle transition idempotently per (date_pacific, state).
  //
  // Quota cost: pollStatsByVideoId chunks videoIds into batches of
  // YOUTUBE_VIDEOS_BATCH_SIZE (50, Google's videos.list cap). Each
  // chunk = one videos.list call = 1 quota unit. So total units =
  // ceil(videoIds.length / 50). Charge 1 unit on the first video of
  // each chunk (i % 50 === 0); rest pass unitsUsed=0. Per Google's
  // quota guide ("all API requests, including invalid requests, incur
  // at least a one-point quota cost"), auth_error and other non-2xx
  // outcomes still consume the unit because the request reached YouTube.
  // The no-key path (pickKeyForJob → null) returns BEFORE this loop.
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
        // Active-tier polls are scheduler-driven → cron pool.
        poolKind: "cron",
        status: snap.status,
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, videoId, err },
        "poll-active: writeSnapshot threw; continuing batch",
      );
    }
    if (snap.status === "rate_limited") rateLimitedSeen = true;
  }

  if (rateLimitedSeen) {
    // Best-effort. The tracker's own state-transition guard makes this
    // idempotent — multiple calls within the same (date_pacific, state)
    // collapse to one audit row.
    try {
      await markThrottleTransition({
        state: "ninetyfive",
        apiKeyId: picked.apiKeyId,
        estimatedUnits: 9500,
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err }, "poll-active: markThrottleTransition failed");
    }
  }

  logger.info(
    { jobId: job.id, tier: "active", count: snapshots.length },
    "youtube.poll.cron tier=active: snapshots written",
  );
}

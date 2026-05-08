// Phase 03.0.1 Plan 07 — Active-tier poll handler (REWRITTEN).
//
// Pre-Plan-07 model (Phase 03.0 Plan 09): scheduler.tick.active cron tick
// fired → src/scheduler/enqueue.ts.enqueueActivePolls() ran → it computed
// the tier window, called selectEligibleVideoIds, and sent per-tier-batch
// jobs to poll.active (with `{ videoIds: string[] }` payload). This
// handler then received the videoIds batch and ran the two-phase tx
// pattern.
//
// Plan-07 model: youtube.poll.cron cron schedule fires DIRECTLY with
// `{ tier: "active" }` payload (via boss.schedule key=active per pg-boss
// v11+ multiple-schedule-per-queue). The poll-cron dispatcher (./poll-cron.ts)
// calls handlePollActive with that tier-tagged job. handlePollActive now
// internally enumerates eligible videos (the work that USED to live in
// scheduler/enqueue.ts.enqueueActivePolls) AND runs the existing two-phase
// HTTP+writeSnapshot pipeline. The intermediate poll.active queue + scheduler-
// tick hop are gone.
//
// Throttle gate: pre-Plan-07 enqueueActivePolls held the throttle gate
// (skip-on-ninetyfive, no-skip-on-eighty); Plan-07 preserves the gate
// HERE since the tier-eligibility computation now lives in the handler.
//
// Per-video discipline: stats polling is per-video — the scheduler keys
// on youtube_videos.published_at (the video's age), not events.occurred_at.
// One videos.list call serves up to 50 ids regardless of how many tenants
// reference each video.
//
// Two-phase tx pattern (Pitfall 5; pinned by tests/integration/poll-worker-tx-boundary.test.ts):
//   A. Phase A — single batched HTTP via pollStatsByVideoId(...) OUTSIDE
//      any tx. Adapter handles the ≤50-id boundary, error mapping, Shorts
//      detection, and the quotaUser fairness param.
//   B. Phase B — writeSnapshot per video result, each in its OWN short tx
//      (snapshot INSERT + youtube_videos UPDATE + quota UPSERT). Tx-
//      boundary < 50ms regardless of upstream YouTube latency.
//
// quotaUser fingerprint: constant `"neotolis-svc-active"` (not per-user).
// Service-driven polls span all tenants; one HTTP serves N tenants
// referencing the same video.
//
// Auth gate: pickKeyForJob() returns null if SERVICE_YOUTUBE_API_KEYS is empty.
// Pre-Plan-07 the no-key path STILL ran through the worker; we preserve
// that behavior — for every eligible video we writeSnapshot status='auth_error'
// so youtube_videos.last_polled_at advances and the tier resolver classifies
// the video as Unavailable on subsequent ticks (D-12).
//
// Throttle transition: when the adapter returns status='rate_limited' for any
// video, we call markThrottleTransition({state:'ninetyfive'}) — first signal
// that the YouTube quota wall has been hit, even though the quota tracker's
// running counter may not yet show 9500.

import {
  TIER_BOUNDARY_ACTIVE_MS,
} from "$lib/server/services/tier-resolver.js";
import { selectEligibleVideoIds } from "$lib/server/services/poll-eligibility.js";
import { youtubeChannelAdapter } from "../adapter.js";
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
 *
 * Pre-Plan-07 callers (poll-active.ts directly invoked with
 * `{ data: { videoIds: string[] } }`) are gone — the scheduler-tick →
 * enqueue.ts hop is retired by this plan.
 */
export async function handlePollActive(job: {
  id?: string;
  data: { tier: "active" } & Record<string, unknown>;
}): Promise<void> {
  // Throttle gate — pause Active tier at ninetyfive (the hard ceiling).
  // 'eighty' lets Active continue (only Cold pauses there). Pre-Plan-07
  // this gate lived in scheduler/enqueue.ts.enqueueActivePolls; with the
  // tier-eligibility computation moving in here, the gate moves with it.
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
      logger.warn(
        { jobId: job.id, err },
        "poll-active: markThrottleTransition (eighty) failed",
      );
    }
  }

  // Tier-eligibility: published_at within the active window (age < 24h).
  // resolveTier() applies the JS-side authoritative classification (the
  // SQL window is a coarse first-cut). Pitfall 7 — never inline the
  // boundary literals; reuse TIER_BOUNDARY_ACTIVE_MS.
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

  // Phase A — HTTP call (OUTSIDE any tx). The adapter handles the ≤50-id
  // boundary, error mapping, Shorts detection, and the quotaUser fairness
  // param. Returns StatsSnapshot[] aligned to input order.
  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(
    videoIds,
    QUOTA_USER_ACTIVE,
    picked,
  );

  // Phase B — writeSnapshot per result. Each call opens its own short tx
  // (snapshot INSERT ON CONFLICT DO NOTHING + youtube_videos UPDATE +
  // quota UPSERT chained). On rate_limited from the adapter, mark the
  // throttle transition idempotently per (date_pacific, state).
  //
  // Quota cost: ONE batched videos.list call (1 quota unit regardless of
  // batch size up to 50 — VERIFIED via spike). Charge the unit on the FIRST
  // result regardless of status; subsequent videos pass unitsUsed=0. Per
  // Google's quota guide ("all API requests, including invalid requests,
  // incur at least a one-point quota cost"), auth_error and other non-2xx
  // outcomes still consume the unit because the request reached YouTube.
  // The no-key path (pickKeyForJob → null) still charges 0 — that branch
  // returns BEFORE this loop and never makes an HTTP request.
  let rateLimitedSeen = false;
  let chargedOnce = false;
  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i]!;
    const snap = snapshots[i]!;
    const unitsThisVideo = !chargedOnce ? 1 : 0;
    if (unitsThisVideo === 1) chargedOnce = true;
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
      logger.warn(
        { jobId: job.id, err },
        "poll-active: markThrottleTransition failed",
      );
    }
  }

  logger.info(
    { jobId: job.id, tier: "active", count: snapshots.length },
    "youtube.poll.cron tier=active: snapshots written",
  );
}

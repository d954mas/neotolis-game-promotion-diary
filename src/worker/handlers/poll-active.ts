// Phase 3.0 Plan 09 + post-build refactor (2026-05-06) — Active-tier poll
// handler.
//
// Receives `{ videoIds: string[] }` jobs enqueued by the scheduler-tick
// handler (src/scheduler/enqueue.ts → enqueueActivePolls). The scheduler
// is the only process that decides "what's due"; this handler trusts the
// videoIds list blind and processes the batch with the two-phase tx
// pattern (Pitfall 5):
//
//   A. Phase A — single batched HTTP via youtubeChannelAdapter.pollStatsByVideoId(...).
//   B. Phase B — writeSnapshot per video result, each in its OWN short tx
//      (snapshot INSERT + youtube_videos UPDATE + quota UPSERT).
//      Tx-boundary < 50ms.
//
// Per-video refactor: the worker no longer SELECTs the events table. The
// scheduler resolved everything (which video_ids to poll, in which tier,
// for which auto-import-enabled tenants). The worker just polls each video
// once and writes the public-data results.
//
// quotaUser fingerprint: constant `"neotolis-svc-active"` (not per-user).
// Service-driven polls span all tenants; one HTTP serves N tenants
// referencing the same video. quotaUser is the burst-shaper hint, NOT the
// daily-quota allocation key — both are global on the operator's keys
// regardless of value.
//
// Tier-resolver is NOT consulted here — the scheduler already filtered.
// Holding a row lock during the upstream HTTP call is the classic anti-pattern
// that cascades into pool exhaustion under transient YouTube latency
// (RESEARCH.md Pattern 2; tests/integration/poll-worker-tx-boundary.test.ts
// pins the boundary).
//
// Auth gate: pickKeyForJob() returns null if SERVICE_YOUTUBE_API_KEYS is empty.
// In that case the adapter degrades to status='auth_error' for every video and
// we still call writeSnapshot so youtube_videos.last_polled_at advances and
// the tier resolver subsequently classifies as Unavailable (D-12).
//
// Throttle transition: when the adapter returns status='rate_limited' for any
// video, we call markThrottleTransition({state:'ninetyfive'}) — this is the
// first signal that the YouTube quota wall has been hit, even though the
// quota tracker's running counter may not yet show 9500 (response lag /
// fairness-shard early reject).

import { youtubeChannelAdapter } from "../../lib/server/integrations/youtube-channel-adapter.js";
import { writeSnapshot } from "../../lib/server/services/youtube-snapshot-writer.js";
import {
  pickKeyForJob,
  markThrottleTransition,
} from "../../lib/server/services/youtube-quota-tracker.js";
import { logger } from "../../lib/server/logger.js";

const QUOTA_USER_ACTIVE = "neotolis-svc-active";

export async function handlePollActive(job: {
  id: string;
  data: { videoIds: string[] };
}): Promise<void> {
  const { videoIds } = job.data;
  if (!videoIds || videoIds.length === 0) {
    logger.debug({ jobId: job.id }, "poll-active: empty videoIds, skipping");
    return;
  }

  // Pre-resolve the API key for this batch so all videos share the same
  // apiKeyId in the writeSnapshot call. The adapter's round-robin still
  // moves forward inside; the per-video quota row is consistent for this
  // batch — the apiKeyId picked at handler start is the one charged.
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: videoIds.length },
      "poll-active: SERVICE_YOUTUBE_API_KEYS empty; videos will degrade to auth_error",
    );
  }

  // Phase A — HTTP call (OUTSIDE any tx). The adapter handles the ≤50-id
  // boundary, error mapping, Shorts detection, and the quotaUser fairness
  // param. Returns StatsSnapshot[] aligned to input order.
  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(videoIds, QUOTA_USER_ACTIVE);

  // Phase B — writeSnapshot per result. Each call opens its own short tx
  // (snapshot INSERT ON CONFLICT DO NOTHING + youtube_videos UPDATE +
  // quota UPSERT chained). On rate_limited from the adapter, mark the
  // throttle transition idempotently per (date_pacific, state).
  //
  // Quota cost: ONE batched videos.list call (1 quota unit regardless of
  // batch size up to 50 — VERIFIED via spike). Charge the unit on the FIRST
  // billable video; subsequent videos pass unitsUsed=0. Counter sum =
  // actual API cost. (auth_error / no-key paths still charge 0 — adapter
  // never billed.)
  const billable = picked && snapshots.some((s) => s.status !== "auth_error");
  let rateLimitedSeen = false;
  let chargedOnce = false;
  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i]!;
    const snap = snapshots[i]!;
    const unitsThisVideo = billable && !chargedOnce && snap.status !== "auth_error" ? 1 : 0;
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
        apiKeyId: picked?.apiKeyId ?? "no-key",
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

  if (rateLimitedSeen && picked) {
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
}

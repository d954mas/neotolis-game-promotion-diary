// Phase 3.0 Plan 09 + post-build refactor (2026-05-06) — Cold-tier poll handler.
//
// Identical pipeline to poll-active.ts: receives `{ videoIds: string[] }`
// jobs, polls each video once via youtubeChannelAdapter.pollStatsByVideoId,
// writes snapshots + youtube_videos UPDATE per result. Differentiation is
// at the QUEUE level (concurrency cap, scheduler-tick frequency), NOT in
// handler logic.
//
// Why two handlers if the logic is identical? Concurrency budget and cron
// frequency. Cold queue is shaped for a once-daily sweep at low concurrency
// (batchSize=1) so it cannot starve Active queue's 6-hour budget. A unified
// handler would still need queue-aware concurrency caps; the duplication
// makes the topology obvious in src/worker/index.ts. quotaUser fingerprint
// is "neotolis-svc-cold" (distinct from active so Google's burst-shaper
// keeps the two ticks in different buckets — they should never overlap in
// time, but a constant-string fingerprint per tier is the cleanest contract).

import { youtubeChannelAdapter } from "../../lib/server/integrations/youtube-channel-adapter.js";
import { writeSnapshot } from "../../lib/server/services/youtube-snapshot-writer.js";
import {
  pickKeyForJob,
  markThrottleTransition,
} from "../../lib/server/services/youtube-quota-tracker.js";
import { logger } from "../../lib/server/logger.js";

const QUOTA_USER_COLD = "neotolis-svc-cold";

export async function handlePollCold(job: {
  id: string;
  data: { videoIds: string[] };
}): Promise<void> {
  const { videoIds } = job.data;
  if (!videoIds || videoIds.length === 0) {
    logger.debug({ jobId: job.id }, "poll-cold: empty videoIds, skipping");
    return;
  }

  // Pre-resolve and thread through (see PickedKey jsdoc on
  // data-source-adapter.ts) — keeps the worker's quota row keyed under
  // the same apiKeyId the adapter actually used for the HTTP.
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: videoIds.length },
      "poll-cold: SERVICE_YOUTUBE_API_KEYS empty; videos will degrade to auth_error",
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
          "poll-cold: writeSnapshot threw on no-key path; continuing",
        );
      }
    }
    return;
  }

  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(
    videoIds,
    QUOTA_USER_COLD,
    picked,
  );

  // Quota counter inflation fix — see poll-active.ts header for rationale.
  // 1 unit per batched videos.list call, charged on first billable video only.
  const billable = snapshots.some((s) => s.status !== "auth_error");
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
        apiKeyId: picked.apiKeyId,
        unitsUsed: unitsThisVideo,
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
}

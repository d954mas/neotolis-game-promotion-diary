// Phase 3.0 post-build refactor (2026-05-06) — weekly rehab-unavailable
// worker handler.
//
// Recovers videos that went private/inaccessible and later came back
// public without requiring user manual refresh. Selects up to N
// 'not_found' / 'private' videos with poll_failure_count < 5 (the
// failure-count cap prevents infinite quota burn on truly-deleted
// videos), polls each, and lets writeSnapshot reset their state to
// 'ok' if Google now returns metrics.
//
// Triggered by a weekly cron (Sundays 4 AM Pacific) — see
// src/scheduler/index.ts for the boss.schedule registration.
//
// Quota cost: REHAB_BATCH_LIMIT (50) units / week worst case if every
// video is still unavailable. ~7 units/day = 0.07% of the 10000 daily
// envelope. Cheap.
//
// Failure-count cap interaction:
//   - Auto-rehab cron walks failure_count < 5.
//   - Manual Refresh now (user-driven) bypasses the cap — user intent
//     overrides cron's "stop trying" decision. Manual success resets
//     failure_count to 0; manual failure increments it (just like
//     auto). After 5 manual fails the user's clicks still go through;
//     the cron just stops volunteer retries.
//
// quotaUser fingerprint: "neotolis-svc-rehab" (distinct from -active /
// -cold so Google's burst-shaper buckets the rehab tick separately).
// Per-tick HTTP volume is bounded at ~50/week so burst is irrelevant
// at our scale.

import { sql, and, lt } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideos } from "$lib/server/db/schema/index.js";
import { youtubeAdapter as youtubeChannelAdapter } from "../index.js";
import { YOUTUBE_VIDEOS_BATCH_SIZE } from "../adapter.js";
import { writeSnapshot } from "../snapshots.js";
import { pickKeyForJob } from "../quota.js";
import { logger } from "$lib/server/logger.js";

const REHAB_BATCH_LIMIT = 50;
const QUOTA_USER_REHAB = "neotolis-svc-rehab";

export async function handleRehabUnavailable(job: { id: string }): Promise<void> {
  // PUBLIC-DATA TABLE — no userId filter (videos are tenant-agnostic).
  // The tenant-scope rule's TENANT_TABLES allowlist excludes youtube_videos
  // (its schema header carries the explicit "public external data, no
  // tenant scope" comment that the rule walks for) so no disable directive
  // is needed here — the rule recognises the table is public-data.
  const candidates = await db
    .select({
      videoId: youtubeVideos.videoId,
    })
    .from(youtubeVideos)
    .where(
      and(
        sql`${youtubeVideos.lastPollStatus} IN ('not_found', 'private')`,
        lt(youtubeVideos.pollFailureCount, 5),
      ),
    )
    .orderBy(sql`${youtubeVideos.lastPolledAt} DESC NULLS LAST`)
    .limit(REHAB_BATCH_LIMIT);

  if (candidates.length === 0) {
    logger.debug({ jobId: job.id }, "rehab-unavailable: no candidates");
    return;
  }

  const videoIds = candidates.map((c) => c.videoId);
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: videoIds.length },
      "rehab-unavailable: SERVICE_YOUTUBE_API_KEYS empty; videos remain unavailable",
    );
    return;
  }

  const snapshots = await youtubeChannelAdapter.pollStatsByVideoId(
    videoIds,
    QUOTA_USER_REHAB,
    picked,
  );

  // Charge 1 unit per batched videos.list call. pollStatsByVideoId chunks
  // into batches of YOUTUBE_VIDEOS_BATCH_SIZE (50, Google's videos.list
  // cap). For rehab REHAB_BATCH_LIMIT=50 means exactly 1 chunk per tick,
  // but using i % 50 === 0 keeps the pattern consistent with poll-active /
  // poll-cold and is correct if the rehab limit ever changes. Per Google's
  // quota guide: "all API requests, including invalid requests, incur at
  // least a one-point quota cost." The no-key path returns BEFORE this loop.
  let recoveredCount = 0;
  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i]!;
    const snap = snapshots[i]!;
    const unitsThisVideo = i % YOUTUBE_VIDEOS_BATCH_SIZE === 0 ? 1 : 0;
    if (snap.status === "ok") recoveredCount += 1;
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
        // Rehab is a weekly cron handler → cron pool.
        poolKind: "cron",
        status: snap.status,
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, videoId, err },
        "rehab-unavailable: writeSnapshot threw; continuing batch",
      );
    }
  }

  // Note: when status='ok' lands, writeSnapshot resets poll_failure_count
  // to 0; future cron walks treat the video as a normal Active/Cold
  // candidate. When status remains 'not_found' / 'private', failure_count
  // increments by 1 — the next cron walk sees it one step closer to the
  // 5-cap exit, after which auto-rehab leaves the video alone.
  logger.info(
    { jobId: job.id, candidates: videoIds.length, recovered: recoveredCount },
    "rehab-unavailable: tick complete",
  );
}

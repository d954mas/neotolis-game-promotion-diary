// Phase 3.0 Plan 09 — Cold-tier poll handler.
//
// Identical pipeline to poll-active.ts: receives `{ eventIds: string[] }`
// jobs, runs the two-phase tx pattern (Pitfall 5), calls the same adapter
// + snapshot-writer chain. Differentiation is at the QUEUE level (concurrency
// cap, scheduler-tick frequency), NOT in handler logic.
//
// Why two handlers if the logic is identical? Concurrency budget and cron
// frequency. Cold queue is shaped for a once-daily sweep at low concurrency
// (batchSize=1) so it cannot starve Active queue's 6-hour budget. A unified
// handler would still need queue-aware concurrency caps; the duplication
// makes the topology obvious in src/worker/index.ts. If the logic ever
// diverges (Plan 03.1 reddit polling adds a tier-specific quota policy),
// this is the natural place for the divergence.

import { sql, and, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../lib/server/db/client.js";
import { events } from "../../lib/server/db/schema/events.js";
import { youtubeChannelAdapter } from "../../lib/server/integrations/youtube-channel-adapter.js";
import { writeSnapshot } from "../../lib/server/services/youtube-snapshot-writer.js";
import {
  pickKeyForJob,
  markThrottleTransition,
} from "../../lib/server/services/youtube-quota-tracker.js";
import { logger } from "../../lib/server/logger.js";

export async function handlePollCold(job: {
  id: string;
  data: { eventIds: string[] };
}): Promise<void> {
  const { eventIds } = job.data;
  if (!eventIds || eventIds.length === 0) {
    logger.debug({ jobId: job.id }, "poll-cold: empty eventIds, skipping");
    return;
  }

  const rows = await db
    .select({
      id: events.id,
      userId: events.userId,
      externalId: events.externalId,
    })
    .from(events)
    .where(
      and(
        inArray(events.id, eventIds),
        isNull(events.deletedAt),
        isNotNull(events.externalId),
        sql`${events.kind} = 'youtube_video'`,
      ),
    );

  const pollable = rows.filter((r) => r.externalId !== null) as {
    id: string;
    userId: string;
    externalId: string;
  }[];
  if (pollable.length === 0) {
    logger.debug({ jobId: job.id, requested: eventIds.length }, "poll-cold: no pollable events");
    return;
  }

  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: pollable.length },
      "poll-cold: SERVICE_YOUTUBE_API_KEYS empty; events will degrade to auth_error",
    );
  }

  const snapshots = await youtubeChannelAdapter.pollStats(
    pollable.map((p) => ({ id: p.id, userId: p.userId, externalId: p.externalId })),
    null,
  );

  let rateLimitedSeen = false;
  for (let i = 0; i < pollable.length; i++) {
    const ev = pollable[i]!;
    const snap = snapshots[i]!;
    try {
      await writeSnapshot({
        videoId: ev.externalId,
        eventId: ev.id,
        userId: ev.userId,
        metrics:
          snap.status === "ok" && snap.metrics
            ? {
                view_count: snap.metrics.view_count ?? 0,
                like_count: snap.metrics.like_count ?? 0,
                comment_count: snap.metrics.comment_count ?? 0,
              }
            : null,
        apiKeyId: picked?.apiKeyId ?? "no-key",
        unitsUsed: picked && snap.status !== "auth_error" ? 1 : 0,
        status: snap.status,
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, eventId: ev.id, err },
        "poll-cold: writeSnapshot threw; continuing batch",
      );
    }
    if (snap.status === "rate_limited") rateLimitedSeen = true;
  }

  if (rateLimitedSeen && picked) {
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

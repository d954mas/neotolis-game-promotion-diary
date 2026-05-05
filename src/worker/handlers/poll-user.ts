// Phase 3.0 Plan 09 — user-driven refresh-now handler.
//
// Receives `{ eventId: string; userId: string; externalId?: string; kind?:
// string }` jobs sent by services/refresh-poll.ts (the route layer for the
// "Refresh now" button). Single-event variant of poll-active; the user
// already paid the 5-min cooldown gate at the route layer (D-10) and the
// scheduler's tier resolver is BYPASSED for this path — Frozen events ARE
// permitted (D-10).
//
// Throttle gate: refresh-now is independent of the quota throttle state.
// Even at 95% the user-driven path keeps working — the worst case is the
// adapter returns 'rate_limited' and the user sees the rate-limited badge.
// This is intentional: users who type the URL for a specific video must be
// able to verify the page renders even when scheduled polling is paused.
//
// Tenant scope: events SELECT filters by (id, userId) — cross-tenant access
// returns no row and the handler logs+skips. The route layer already gates
// access via NotFoundError; this is defense-in-depth at the worker level.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../lib/server/db/client.js";
import { events } from "../../lib/server/db/schema/events.js";
import { youtubeChannelAdapter } from "../../lib/server/integrations/youtube-channel-adapter.js";
import { writeSnapshot } from "../../lib/server/services/youtube-snapshot-writer.js";
import { pickKeyForJob } from "../../lib/server/services/youtube-quota-tracker.js";
import { logger } from "../../lib/server/logger.js";

export async function handlePollUser(job: {
  id: string;
  data: { eventId: string; userId: string };
}): Promise<void> {
  const { eventId, userId } = job.data;
  if (!eventId || !userId) {
    logger.warn({ jobId: job.id }, "poll-user: missing eventId or userId in job data");
    return;
  }

  // Phase A — fetch event tenant-scoped. ESLint tenant-scope rule enforced
  // by the eq(events.userId, userId) clause.
  const rows = await db
    .select({
      id: events.id,
      userId: events.userId,
      externalId: events.externalId,
      kind: events.kind,
    })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.userId, userId), isNull(events.deletedAt)));

  const event = rows[0];
  if (!event || !event.externalId) {
    logger.warn(
      { jobId: job.id, eventId, userId, found: !!event },
      "poll-user: event missing or has no externalId; skipping",
    );
    return;
  }
  if (event.kind !== "youtube_video") {
    logger.warn(
      { jobId: job.id, eventId, kind: event.kind },
      "poll-user: event is not a youtube_video; skipping",
    );
    return;
  }

  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, eventId },
      "poll-user: SERVICE_YOUTUBE_API_KEYS empty; degrading to auth_error",
    );
  }

  // Phase B — HTTP via adapter (single event batch). pollStats accepts an
  // array; we pass a length-1 array so the same code path serves user-driven
  // and scheduler-driven calls.
  const snapshots = await youtubeChannelAdapter.pollStats(
    [{ id: event.id, userId: event.userId, externalId: event.externalId }],
    null,
  );
  const snap = snapshots[0]!;

  // Phase C — single write tx via writeSnapshot.
  try {
    await writeSnapshot({
      videoId: event.externalId,
      eventId: event.id,
      userId: event.userId,
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
    logger.error({ jobId: job.id, eventId, err }, "poll-user: writeSnapshot threw");
    throw err; // Single-event handler: rethrow so pg-boss retries per queue policy.
  }

}

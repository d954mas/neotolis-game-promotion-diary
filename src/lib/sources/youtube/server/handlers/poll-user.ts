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
import { db } from "$lib/server/db/client.js";
import { events } from "$lib/server/db/schema/events.js";
import { youtubeAdapter as youtubeChannelAdapter } from "../index.js";
import { writeSnapshot } from "../snapshots.js";
import { pickKeyForJob } from "../quota.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";
import { markSourceNeedsReconnect } from "$lib/server/services/data-sources.js";

export async function handlePollUser(job: {
  id: string;
  data: { eventId: string; userId: string };
}): Promise<void> {
  // Plan 08 (D-13) AdapterError envelope. Same routing contract as
  // channel-context-backfill — see that file's handler header for the
  // category-by-category rationale. poll-user runs in user-driven origin;
  // sourceId is resolved from the event row when AdapterError fires
  // against an auto-imported event (events.source_id IS NOT NULL); manual-
  // paste events have source_id=NULL and we just log+swallow without
  // flipping any source's needs_reconnect (no source to flip).
  try {
    await handlePollUserImpl(job);
  } catch (err) {
    if (err instanceof AdapterError) {
      if (err.category === "rate-limited" || err.category === "transient") {
        logger.info(
          { jobId: job.id, category: err.category, retryAfterMs: err.retryAfterMs },
          "poll-user: AdapterError → pg-boss retry",
        );
        throw err;
      }
      // operator-issue / permanent / not-found → load the event to find
      // sourceId, then conditionally flip needs_reconnect.
      const { eventId, userId } = job.data;
      if (eventId && userId && (err.category === "operator-issue" || err.category === "permanent")) {
        // Tenant-scoped lookup — Pattern 1.
        const evRows = await db
          .select({ sourceId: events.sourceId })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.userId, userId)))
          .limit(1);
        const sId = evRows[0]?.sourceId ?? null;
        if (sId) {
          await markSourceNeedsReconnect(userId, sId, err.category);
        }
      }
      logger.warn(
        { jobId: job.id, category: err.category, eventId: job.data.eventId },
        "poll-user: AdapterError swallowed (worker won't retry)",
      );
      return;
    }
    throw err;
  }
}

async function handlePollUserImpl(job: {
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

  // Pre-resolve and thread through the adapter (see PickedKey jsdoc on
  // $lib/sources/adapter.ts). With one key in env this matches the
  // previous behavior; with N≥2 keys this is the load-bearing fix that
  // keeps the youtube_service_quota_usage row keyed under the same
  // apiKeyId the adapter actually used.
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, eventId },
      "poll-user: SERVICE_YOUTUBE_API_KEYS empty; degrading to auth_error",
    );
    try {
      await writeSnapshot({
        videoId: event.externalId,
        metrics: null,
        apiKeyId: "no-key",
        unitsUsed: 0,
        status: "auth_error",
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, eventId, err },
        "poll-user: writeSnapshot threw on no-key path; logging and returning",
      );
    }
    return;
  }

  // Phase B — HTTP via adapter (single event batch). pollStats accepts an
  // array; we pass a length-1 array so the same code path serves user-driven
  // and scheduler-driven calls.
  const snapshots = await youtubeChannelAdapter.pollStats(
    [{ id: event.id, userId: event.userId, externalId: event.externalId }],
    null,
    picked,
  );
  const snap = snapshots[0]!;

  // Phase C — single write tx via writeSnapshot.
  //
  // Catch-and-log instead of rethrow (post-build review 2026-05-07): a
  // rethrow here triggers pg-boss retry → another HTTP to YouTube → 1
  // more quota unit per retry. A flaky DB during a flurry of refresh-now
  // clicks could 3-5× the quota burn. The user already paid the
  // upstream call; if writeSnapshot fails the data is gone, but charging
  // another N units to retry the same outcome is worse than logging and
  // letting the user click again.
  try {
    await writeSnapshot({
      videoId: event.externalId,
      metrics:
        snap.status === "ok" && snap.metrics
          ? {
              view_count: snap.metrics.view_count ?? 0,
              like_count: snap.metrics.like_count ?? 0,
              comment_count: snap.metrics.comment_count ?? 0,
            }
          : null,
      apiKeyId: picked.apiKeyId,
      // Per Google's quota guide ("all API requests, including invalid
      // requests, incur at least a one-point quota cost") every Response
      // costs 1 unit — including auth_error and rate_limited. The no-key
      // path returns at line 82 before this writeSnapshot runs, charging
      // 0 there; reaching this point means an HTTP request was made.
      unitsUsed: 1,
      status: snap.status,
    });
  } catch (err) {
    logger.error(
      { jobId: job.id, eventId, err },
      "poll-user: writeSnapshot threw; logging — refresh-now polls do NOT retry to avoid quota multiplication",
    );
  }
}

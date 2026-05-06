// Phase 3.0 Plan 09 — Active-tier poll handler.
//
// Receives `{ eventIds: string[] }` jobs enqueued by the scheduler-tick handler
// (src/scheduler/enqueue.ts → enqueueActivePolls). The scheduler is the only
// process that decides "what's due"; this handler trusts the eventIds list
// blind and processes the batch with the two-phase tx pattern (Pitfall 5):
//
//   A. Phase A — short SELECT (no FOR UPDATE) loads events by id.
//   B. Phase B — youtubeChannelAdapter.pollStats(...) HTTP call OUTSIDE any tx.
//   C. Phase C — writeSnapshot per result, each in its OWN short tx (snapshot
//      INSERT + events UPDATE + quota UPSERT). Tx-boundary < 50ms.
//
// Tier-resolver is NOT consulted here — the scheduler already filtered.
// Holding a row lock during the upstream HTTP call is the classic anti-pattern
// that cascades into pool exhaustion under transient YouTube latency
// (RESEARCH.md Pattern 2; tests/integration/poll-worker-tx-boundary.test.ts
// pins the boundary).
//
// Auth gate: pickKeyForJob() returns null if SERVICE_YOUTUBE_API_KEYS is empty.
// In that case the adapter degrades to status='auth_error' for every event and
// we still call writeSnapshot so events.last_polled_at advances and the tier
// resolver subsequently classifies the event as Unavailable (D-12).
//
// Throttle transition: when the adapter returns status='rate_limited' for any
// event, we call markThrottleTransition({state:'ninetyfive'}) — this is the
// first signal that the YouTube quota wall has been hit, even though the
// quota tracker's running counter may not yet show 9500 (response lag /
// fairness-shard early reject).

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

export async function handlePollActive(job: {
  id: string;
  data: { eventIds: string[] };
}): Promise<void> {
  const { eventIds } = job.data;
  if (!eventIds || eventIds.length === 0) {
    logger.debug({ jobId: job.id }, "poll-active: empty eventIds, skipping");
    return;
  }

  // Phase A — short SELECT (no FOR UPDATE). Filter to youtube_video kind +
  // not soft-deleted + has externalId. Other kinds slip through if the
  // scheduler enqueued them by mistake; we filter here as defense-in-depth.
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
    logger.debug({ jobId: job.id, requested: eventIds.length }, "poll-active: no pollable events");
    return;
  }

  // Pre-resolve the API key for this batch so all events share the same
  // apiKeyId in the writeSnapshot call. The adapter does its own pickKeyForJob
  // per HTTP call internally, but the writeSnapshot writer needs ONE
  // identifier per event for quota accounting; the simplest contract is "the
  // apiKeyId picked at handler start is the one charged" — round-robin still
  // moves forward inside the adapter, but the per-event quota row is
  // consistent.
  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, batchSize: pollable.length },
      "poll-active: SERVICE_YOUTUBE_API_KEYS empty; events will degrade to auth_error",
    );
  }

  // Phase B — HTTP call (OUTSIDE any tx). The adapter handles batching at the
  // ≤50-id boundary, the quotaUser fairness param, error mapping, and Shorts
  // detection. Returns StatsSnapshot[] aligned to input order.
  const snapshots = await youtubeChannelAdapter.pollStats(
    pollable.map((p) => ({ id: p.id, userId: p.userId, externalId: p.externalId })),
    null,
  );

  // Phase C — writeSnapshot per result. Each call opens its own short tx
  // (snapshot INSERT ON CONFLICT DO NOTHING + events UPDATE tenant-scoped +
  // quota UPSERT chained). On rate_limited from the adapter, mark the
  // throttle transition idempotently per (date_pacific, state).
  // Phase 3.0 post-build (UAT 2026-05-06) — quota counter inflation fix.
  // Adapter does ONE batched videos.list call per pollStats() invocation
  // (1 quota unit regardless of batch size up to 50 — VERIFIED via spike).
  // writeSnapshot used to charge 1 unit per event = 50× over-count for a
  // 50-event batch. Now we pay the unit on the FIRST event only;
  // subsequent events pass 0. Counter sum = actual API cost.
  // (auth_error / no-key paths still charge 0 — adapter never billed.)
  const billable = picked && snapshots.some((s) => s.status !== "auth_error");
  let rateLimitedSeen = false;
  let chargedOnce = false;
  for (let i = 0; i < pollable.length; i++) {
    const ev = pollable[i]!;
    const snap = snapshots[i]!;
    const unitsThisEvent = billable && !chargedOnce && snap.status !== "auth_error" ? 1 : 0;
    if (unitsThisEvent === 1) chargedOnce = true;
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
        unitsUsed: unitsThisEvent,
        status: snap.status,
      });
    } catch (err) {
      logger.error(
        { jobId: job.id, eventId: ev.id, err },
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

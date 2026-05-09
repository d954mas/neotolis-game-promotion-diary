// Phase 3.0 Plan 04 — refresh-poll service (CONTEXT D-10).
//
// User-driven "Refresh now" button enqueues an upstream poll on
// `youtube.poll.user` (Phase 03.0.1 Plan 07 — was `poll.user` pre-rename)
// with a 5-minute cooldown gate. The cooldown is per-event and persisted in
// `events.metadata.last_user_refresh_at` (eager-write; survives container
// restart so the next attempt still honors it). Frozen-tier events ARE
// permitted to refresh (CONTEXT D-10) — the tier resolver only gates the
// scheduler's automatic enqueue, not the user-driven path.
//
// Error contract:
//   - cross-tenant or missing event       → NotFoundError (HTTP 404)
//   - kind not in { youtube_video }       → AppError 'event_not_pollable' (422)
//                                             — Phase 3.1 lands reddit_post
//   - external_id IS NULL                 → AppError 'event_no_external_id' (422)
//                                             — manual paste of a YouTube URL
//                                               always derives videoId, but a
//                                               legacy row pre-Plan 02.1-17
//                                               could lack one
//   - within 5-minute cooldown window     → AppError 'too_many_refreshes' (429)
//                                             with metadata.minutesLeft +
//                                             metadata.retryAfterSeconds for
//                                             the route layer to surface a
//                                             Retry-After header (Plan 03.0-08)
//
// Tx-boundary discipline (Pitfall 5): the events fetch + metadata update
// are short DB operations; the boss.send call follows. We do NOT wrap the
// whole flow in `db.transaction` — the eager-write before enqueue is a
// correctness choice (a crash mid-enqueue still honors the cooldown on the
// next attempt) and matches the Phase 02.2 quota pattern.
//
// Audit: writes `event.poll_refreshed` row scoped to the event owner. The
// audit row is written OUTSIDE any tx (Phase 02.2 pool-deadlock-safe pattern;
// audit failures must not break the user-facing path — see audit.ts header).

import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { youtubeVideos } from "../db/schema/index.js";
import { AppError, NotFoundError } from "./errors.js";
import { writeAudit } from "../audit.js";
import { QUEUES } from "../queues.js";
import { getBoss } from "../queue-client.js";
import { eventKindToSourceKind } from "$lib/sources/event-to-source-kind.js";
import { getAdapter, hasAdapter } from "$lib/sources/registry.js";

const COOLDOWN_MS = 5 * 60 * 1000;

export interface RefreshPollResult {
  enqueued: true;
  queue: "youtube.poll.user";
  eventId: string;
}

export async function requestRefreshPoll(
  userId: string,
  eventId: string,
  ipAddress = "127.0.0.1",
  userAgent?: string,
): Promise<RefreshPollResult> {
  // 1. Fetch the event tenant-scoped. PRIV-01: cross-tenant or missing →
  //    NotFoundError → HTTP 404 (never 403).
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.userId, userId), isNull(events.deletedAt)));
  const event = rows[0];
  if (!event) throw new NotFoundError();

  // 2. Pollable-kind gate. Phase 03.0.1 architecture cleanup — registry-driven:
  //    asks the adapter whose SourceKind maps to this event's kind whether it
  //    can refresh-poll. Phase 03.1 Reddit's adapter returns true for
  //    reddit_post; this code stays unchanged. Kinds with no adapter (event
  //    kinds that are never poll-driven — conference, talk, press, other) and
  //    adapters whose canRefreshPoll returns false are blocked uniformly.
  const sourceKindForPoll = eventKindToSourceKind(event.kind);
  const pollableAdapter =
    sourceKindForPoll !== null && hasAdapter(sourceKindForPoll)
      ? getAdapter(sourceKindForPoll)
      : null;
  if (pollableAdapter === null || pollableAdapter.canRefreshPoll?.(event.kind) !== true) {
    throw new AppError(
      `event kind '${event.kind}' is not pollable in Phase 3.0`,
      "event_not_pollable",
      422,
      { kind: event.kind, event_id: eventId },
    );
  }

  // 3. External-id gate. The poll worker keys upstream calls by external_id
  //    (YouTube videoId). A row without one cannot be polled.
  if (!event.externalId) {
    throw new AppError(
      "event has no external_id; cannot refresh-poll",
      "event_no_external_id",
      422,
      { event_id: eventId, kind: event.kind },
    );
  }

  // 3a. Per-video refactor (2026-05-06) — 'pending' tier gate.
  //     If channel-context-backfill has not yet run for this external_id,
  //     youtube_videos may not have a row yet, OR its publishedAt may be
  //     NULL. Either way the tier is 'pending' and a manual poll would
  //     race the in-flight backfill (which will populate stats anyway).
  //     Reject with 422 — the user can retry once badge transitions.
  // PUBLIC-DATA TABLE — keyed on PK only, no userId filter.
  const videoRows = await db
    .select({ publishedAt: youtubeVideos.publishedAt })
    .from(youtubeVideos)
    .where(eq(youtubeVideos.videoId, event.externalId))
    .limit(1);
  const videoRow = videoRows[0];
  if (!videoRow || videoRow.publishedAt === null) {
    throw new AppError(
      "video metadata not yet available; backfill in progress",
      "pending_backfill",
      422,
      { event_id: eventId, external_id: event.externalId },
    );
  }

  // 4. 5-minute cooldown gate (CONTEXT D-10). Reads
  //    events.metadata.last_user_refresh_at; throws AppError 429 with
  //    metadata.minutesLeft + metadata.retryAfterSeconds if within window.
  //    Frozen-tier events are NOT gated here — the tier resolver only gates
  //    the SCHEDULER's automatic enqueue (Plan 03.0-09); user-driven refresh
  //    is permitted at any age (D-10).
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const lastRefreshIso =
    typeof meta.last_user_refresh_at === "string" ? meta.last_user_refresh_at : null;
  const lastRefreshAt = lastRefreshIso ? new Date(lastRefreshIso) : null;
  const now = new Date();
  if (
    lastRefreshAt !== null &&
    !Number.isNaN(lastRefreshAt.getTime()) &&
    now.getTime() - lastRefreshAt.getTime() < COOLDOWN_MS
  ) {
    const msLeft = COOLDOWN_MS - (now.getTime() - lastRefreshAt.getTime());
    const minutesLeft = Math.max(1, Math.ceil(msLeft / 60_000));
    const retryAfterSeconds = Math.max(1, Math.ceil(msLeft / 1000));
    throw new AppError("refresh-poll cooldown active", "too_many_refreshes", 429, {
      minutesLeft,
      retryAfterSeconds,
      event_id: eventId,
    });
  }

  // 5. Persist last_user_refresh_at BEFORE enqueueing so a crash mid-enqueue
  //    still honors the cooldown on the next attempt. Eager-write pattern
  //    matches Phase 02.2 quota's "claim the slot, then do the work".
  //
  //    Phase 3.0 post-build (UAT 2026-05-06) — atomic write:
  //    1) Use Postgres `||` jsonb merge so we don't clobber other metadata
  //       fields (`inbox.dismissed`, `triage.standalone`, etc.) that a
  //       parallel write may have set between our SELECT and our UPDATE.
  //       The write is idempotent for `last_user_refresh_at` and partial
  //       for everything else.
  //    2) Add a cutoff predicate on the WHERE so two concurrent requests
  //       can't both pass the cooldown gate: only one will see the
  //       still-stale (or null) timestamp and the UPDATE for the other
  //       returns 0 rows. The 0-rows path treats the slot as "lost" and
  //       throws the same 429 as the in-window check above.
  const cutoffIso = new Date(now.getTime() - COOLDOWN_MS).toISOString();
  const updateRes = await db
    .update(events)
    .set({
      // Cast to ::text — `jsonb_build_object`'s value parameter is variadic
      // "any" so PG cannot infer the placeholder type without a hint.
      metadata: sql`${events.metadata} || jsonb_build_object('last_user_refresh_at', ${now.toISOString()}::text)`,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.userId, userId),
        // Wrap the OR explicitly: drizzle's `and()` injects AND between
        // its arguments, so a bare `A IS NULL OR A < cutoff` term ends up
        // as `(prev AND prev2 AND A IS NULL) OR A < cutoff` — wrong shape.
        // Cast $cutoff to text so PG can infer parameter type when the
        // left side is the jsonb `->>` extraction.
        sql`((${events.metadata} ->> 'last_user_refresh_at') IS NULL OR (${events.metadata} ->> 'last_user_refresh_at') < ${cutoffIso}::text)`,
      ),
    )
    .returning({ id: events.id });
  if (updateRes.length === 0) {
    // A concurrent refresh-poll won the race. Same response as if we'd
    // detected the cooldown above; the user retries after the window.
    throw new AppError("refresh-poll cooldown active", "too_many_refreshes", 429, {
      minutesLeft: 1,
      retryAfterSeconds: 60,
      event_id: eventId,
    });
  }

  // 6. Enqueue with singletonKey scoped to per-minute window. pg-boss v10
  //    coalesces same-singletonKey jobs across the dedup window, preventing
  //    accidental flood from a button mash. Priority 10 ranks ahead of
  //    scheduled (default 0) cron-driven work (Plan 03.0-09 schedules at 0).
  const boss = await getBoss();
  const minuteKey = now.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
  await boss.send(
    QUEUES.YOUTUBE_POLL_USER,
    { eventId, userId, externalId: event.externalId, kind: event.kind },
    {
      singletonKey: `${eventId}-${minuteKey}`,
      priority: 10,
    },
  );

  // 7. Audit row scoped to the event owner. Written OUTSIDE any tx (Phase
  //    02.2 pool-deadlock-safe pattern). Audit failures are swallowed by
  //    audit.ts so they never break the user-facing path.
  //
  // Phase 03.0.1 — extended metadata for per-user cap counter:
  //   flow='stats_refresh' (capped) + requests_used=1 (one videos.list call,
  //   1 quota unit) + events_inserted=0 (no new event rows; this refreshes
  //   stats on existing event/snapshot tables).
  // Cap query (services/quota.ts:getUserQuotaUsedToday) sums these across
  // user-initiated capped flows (incremental + historical + stats_refresh).
  await writeAudit({
    userId,
    action: "event.poll_refreshed",
    ipAddress,
    userAgent,
    metadata: {
      event_id: eventId,
      kind: event.kind,
      external_id: event.externalId,
      flow: "stats_refresh",
      requests_used: 1,
      events_inserted: 0,
    },
  });

  return { enqueued: true, queue: "youtube.poll.user", eventId };
}

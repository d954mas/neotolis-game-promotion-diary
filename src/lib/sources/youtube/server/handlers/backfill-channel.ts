// Phase 03.0.1 Wave 2 — youtube.backfill.channel queue handler.
//
// Channel-scoped polling. Replaces the per-source backfill-user.ts handler.
// One walk per channel per call; fan-out INSERT to ALL active subscribers.
//
// Triggered by:
//   - POST /api/sources/:id/refresh-content — user click. Job payload sets
//     triggerUserId; user pays quota from their pool, ALL subscribers (not
//     just trigger user) receive events. Singleton key by channelKey
//     dedupes parallel clicks across users.
//
//   - youtube.auto_backfill_cron daily picker — cron-driven historical
//     backfill. triggerUserId undefined; cron pool consumed; flow=auto_passive.
//     Cron picker SELECTs DISTINCT channel_key with at least one active
//     subscriber, enqueues one backfill.channel job per channel.
//
// CONTRACT (D-10 per-kind queue topology, channel-scoped revision):
//   - Queue:   YOUTUBE_BACKFILL_CHANNEL ("youtube.backfill.channel")
//   - Payload: { kind, channelKey, triggerUserId?, depthBoundIso, flow }
//   - Side effects:
//     1. ONE adapter.pollContent call (paginated walk).
//     2. Fan-out INSERT to events for each active subscriber, filtered by
//        per-user target_since + auto_import + idempotency UNIQUE.
//     3. UPDATE on data_source_channel_state (last_polled_at, frontier,
//        complete, cursor).
//     4. ONE audit row for triggerUserId (only when user-triggered) —
//        cap counter charges trigger user; subscribers free-ride.
//     5. Per-source needs_reconnect flagged on operator-issue / permanent
//        AdapterError categories — applied to EVERY active subscriber's
//        source (the platform issue affects all).
//
// CROSS-TENANT BY DESIGN. The handler intentionally walks subscribers across
// users — that is the entire point of channel-scoped polling. Tenant
// scoping happens at:
//   1. INSERT-into-events fan-out — each subscriber's user_id row is
//      independent; idempotency UNIQUE (user_id, source_id, kind, external_id)
//      protects per-user.
//   2. Audit attribution — only triggerUserId gets the audit row.
//   3. Cap accounting — only triggerUserId pays quota; cron flows skip audit.

import { and, eq, isNotNull, isNull, sql, inArray } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { youtubeVideos as youtubeVideosTable } from "../schema/index.js";
import { logger } from "$lib/server/logger.js";
import { writeAuditStrict } from "$lib/server/audit.js";
import { markSourceNeedsReconnect } from "$lib/server/services/data-sources.js";
import {
  getChannelState,
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
  setChannelBackfillPageToken,
} from "$lib/server/services/channel-state.js";
import { youtubeChannelAdapterCore as adapter } from "../adapter.js";
import { getNewestKnownPublishedAt } from "../newest-known.js";
import { AdapterError } from "$lib/sources/errors.js";
import type { SourceKind } from "$lib/sources/adapter.js";

type BackfillFlow = "initial" | "incremental" | "historical" | "auto_passive";

interface BackfillChannelJob {
  id?: string;
  data: {
    kind: SourceKind;
    /** Stable channel identifier — UCxxx for YouTube. */
    channelKey: string;
    /** UserId who triggered this walk. Undefined for cron. The trigger user
     *  pays quota from their per-user cap; cron flows skip user audit and
     *  consume operator cron pool. */
    triggerUserId?: string;
    /** Walk depth target — earliest publishedAt to walk to. ISO 8601 string.
     *  Per Q2 design:
     *    - user click: trigger user's source.backfill_target_since
     *    - cron auto-backfill: '1970-01-01T00:00:00Z' sentinel (= endOfPlaylist) */
    depthBoundIso: string;
    /** Audit flow tag — capped flows (initial/incremental/historical) count
     *  toward trigger user's per-user requestsPerDay cap;
     *  auto_passive does NOT count and does not write audit. */
    flow: BackfillFlow;
  };
}

/** Service-tier quotaUser fingerprint for cron-driven channel walks.
 *  Matches the QUOTA_USER_COLD pattern used by per-event poll handlers. */
const QUOTA_USER_BACKFILL = "neotolis-svc-backfill";

export async function handleBackfillChannel(job: BackfillChannelJob): Promise<void> {
  const { kind, channelKey, triggerUserId } = job.data;
  let flow: BackfillFlow = job.data.flow ?? "auto_passive";

  if (typeof channelKey !== "string" || typeof kind !== "string") {
    logger.warn(
      { jobId: job.id, payload: job.data },
      "youtube.backfill.channel: malformed payload (missing kind/channelKey); skipping",
    );
    return;
  }
  if (kind !== "youtube_channel") {
    logger.warn({ jobId: job.id, kind }, "youtube.backfill.channel: unsupported kind; skipping");
    return;
  }

  // 1. Lookup all active subscribers for this channel.
  // CROSS-TENANT BY DESIGN — see header comment.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, kind),
        eq(dataSources.channelId, channelKey),
        isNull(dataSources.deletedAt),
      ),
    );
  if (subscribers.length === 0) {
    logger.info(
      { jobId: job.id, kind, channelKey },
      "youtube.backfill.channel: no active subscribers — channel orphaned; skipping",
    );
    return;
  }

  // 2. Resolve channel state (auto-create on first walk via mark*/set* helpers).
  const channelState = await getChannelState(kind, channelKey);

  // 3. Compute since — three-branch derivation (Phase 03.0.3 P1; D-#29-2).
  //
  // The walker historically used `since = depthBoundIso` unconditionally;
  // that re-walks the full uploads playlist on every click when the user's
  // target is epoch (~110 quota units across 8 channels with zero new
  // videos). The branch logic gates the walk depth using the channel's
  // newest-known publishedAt cursor + the channel's prior walk frontier.
  //
  // Branches (D-#29-2 — applies identically to ctx.origin user AND cron):
  //   - exhausted   (backfill_complete=true)
  //                 since = max(newestKnown, target)  — steady state
  //   - incremental (!complete && deepestWalked !== null && target >= deepestWalked)
  //                 since = max(newestKnown, target)  — partial walk, target shallower
  //   - deep        (else)
  //                 since = target                    — no prior walk OR target deeper
  //
  // Token clearing rule (D-#29-3): exhausted + incremental branches CLEAR
  // metadata.lastBackfillPageToken before adapter.pollContent. Deep branch
  // preserves it (resume cursor for >MAX_PAGES walks). Without this clear,
  // a stale page-N cursor from a prior deep walk would cause walkedPastSince
  // to fire immediately on the incremental click with zero events.
  const target = new Date(job.data.depthBoundIso);
  if (Number.isNaN(target.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      "youtube.backfill.channel: invalid depthBoundIso; skipping",
    );
    return;
  }
  const newestKnown = await getNewestKnownPublishedAt(channelKey);
  const deepestWalked = channelState?.backfillOldestAt ?? null;
  let branch: "exhausted" | "incremental" | "deep";
  if (channelState?.backfillComplete === true) {
    branch = "exhausted";
  } else if (deepestWalked !== null && target.getTime() >= deepestWalked.getTime()) {
    branch = "incremental";
  } else {
    branch = "deep";
  }
  const since =
    branch === "deep"
      ? target
      : newestKnown !== null && newestKnown.getTime() > target.getTime()
        ? newestKnown
        : target;
  const incrementalBranchTaken = branch !== "deep";
  if (incrementalBranchTaken) {
    // D-#29-3 — clear stale resume cursor before incremental walk.
    await setChannelBackfillPageToken(kind, channelKey, null);
  }

  // 4. Build PollableSource shape for adapter (legacy name; semantically a
  //    channel context now). userId is the quotaUser fingerprint:
  //    - user click: trigger user's id (per-user Google fairness bucket)
  //    - cron: service-tier constant (one bucket for all cron walks)
  let pollResult: {
    events: {
      externalId?: string;
      occurredAt: Date;
      title: string;
      url: string;
      metadata?: Record<string, unknown>;
    }[];
    unitsUsed: number;
    nextPageToken?: string;
    endOfPlaylist?: boolean;
  };
  try {
    pollResult = await adapter.pollContent(
      {
        id: channelKey,
        userId: triggerUserId ?? QUOTA_USER_BACKFILL,
        metadata: {
          channelId: channelKey,
          lastBackfillPageToken: (
            channelState?.metadata as { lastBackfillPageToken?: string } | undefined
          )?.lastBackfillPageToken,
        },
      },
      since,
      { origin: triggerUserId ? "user" : "cron" },
    );
  } catch (err) {
    if (err instanceof AdapterError) {
      if (err.category === "rate-limited" || err.category === "transient") {
        logger.info(
          { jobId: job.id, kind, channelKey, category: err.category },
          "youtube.backfill.channel: AdapterError → pg-boss retry",
        );
        throw err;
      }
      if (err.category === "operator-issue" || err.category === "permanent") {
        // Platform-level issue affects ALL subscribers — flag every active
        // source so admin sees it (Phase 6+) and per-user UI surfaces the
        // reconnect requirement.
        for (const sub of subscribers) {
          await markSourceNeedsReconnect(sub.userId, sub.id, err.category);
        }
      }
    }
    await markChannelLastPolledAt(kind, channelKey);
    if (triggerUserId) {
      await writeBackfillAudit({
        job,
        flow,
        kind,
        channelKey,
        triggerUserId,
        requestsUsed: 0,
        eventsInserted: 0,
        sinceBranch: branch,
      });
    }
    logger.warn(
      {
        jobId: job.id,
        kind,
        channelKey,
        category: err instanceof AdapterError ? err.category : "non-adapter",
        err: String((err as Error)?.message ?? err),
      },
      "youtube.backfill.channel: pollContent threw; channel state stamped",
    );
    return;
  }

  // 5. Empty result handling. Empty + unitsUsed > 0 = platform confirmed
  //    no items (end of playlist OR walked past since on first page).
  //    Mark complete only when at least one HTTP call landed — empty + 0
  //    means precondition missing (no API key / unresolvable playlist).
  if (pollResult.events.length === 0) {
    if (pollResult.unitsUsed > 0) {
      await markChannelBackfillComplete(kind, channelKey);
      await setChannelBackfillPageToken(kind, channelKey, null);
    }
    await markChannelLastPolledAt(kind, channelKey);
    if (triggerUserId) {
      await writeBackfillAudit({
        job,
        flow,
        kind,
        channelKey,
        triggerUserId,
        requestsUsed: pollResult.unitsUsed,
        eventsInserted: 0,
        sinceBranch: branch,
      });
    }
    logger.info(
      { jobId: job.id, kind, channelKey, flow, unitsUsed: pollResult.unitsUsed },
      "youtube.backfill.channel: empty result",
    );
    return;
  }

  // 6. Detect 'historical' flow upgrade for user clicks. If channel state
  //    still has historical work past current frontier (oldSide present),
  //    the click goes deeper than incremental territory — audit reflects.
  if (
    flow === "incremental" &&
    triggerUserId &&
    channelState?.backfillOldestAt &&
    since.getTime() < channelState.backfillOldestAt.getTime()
  ) {
    flow = "historical";
  }

  // 7. Bulk idempotency check. ONE SELECT covers all (subscriber, externalId)
  //    pairs. Builds a Set keyed `${userId}|${sourceId}|${externalId}` for
  //    O(1) skip lookup in the fan-out loop below.
  const externalIds = pollResult.events
    .map((e) => e.externalId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const existingSet = new Set<string>();
  if (externalIds.length > 0 && subscribers.length > 0) {
    const userIds = subscribers.map((s) => s.userId);
    const sourceIds = subscribers.map((s) => s.id);
    // CROSS-TENANT BY DESIGN — fan-out idempotency check spans subscribers
    // via inArray(events.userId, userIds). Tenant-scope ESLint rule's regex
    // accepts inArray usage so no disable directive needed.
    const existing = await db
      .select({
        userId: events.userId,
        sourceId: events.sourceId,
        externalId: events.externalId,
      })
      .from(events)
      .where(
        and(
          inArray(events.userId, userIds),
          inArray(events.sourceId, sourceIds),
          inArray(events.externalId, externalIds),
          sql`${events.kind} = 'youtube_video'`,
          isNotNull(events.externalId),
          isNull(events.deletedAt),
        ),
      );
    for (const r of existing) {
      if (r.externalId) existingSet.add(`${r.userId}|${r.sourceId}|${r.externalId}`);
    }
  }

  // 8. youtube_videos cache UPSERT for every fetched event. Phase 03.0.1
  //    Wave 4 (post-UAT 2026-05-10) — without this the channel-scoped
  //    polling path INSERTed events but left youtube_videos cache empty
  //    for those video_ids. PollingBadge tier resolver reads
  //    youtube_videos.publishedAt; missing → tier=pending → "Pending ·
  //    fetching video info…" badge with no stats forever (until manual
  //    refresh-poll click hit the user). channel-context-backfill DOES
  //    write the cache, but that path runs only at onSourceCreated for
  //    a single backfill window — it doesn't re-fire for cron walks or
  //    refresh-content clicks that walk past the original window.
  //
  //    UPSERT on video_id PK — public-data, no userId scope. Only writes
  //    snippet fields we have from pollContent (title, publishedAt,
  //    channelId). Stats land separately via active/cold poll workers
  //    (which read this row to compute tier).
  for (const ev of pollResult.events) {
    if (!ev.externalId) continue;
    const evChannelId =
      typeof ev.metadata?.channelId === "string" ? ev.metadata.channelId : channelKey;
    await db
      .insert(youtubeVideosTable)
      .values({
        videoId: ev.externalId,
        title: ev.title,
        channelId: evChannelId,
        publishedAt: ev.occurredAt,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: youtubeVideosTable.videoId,
        set: {
          title: ev.title,
          channelId: evChannelId,
          publishedAt: ev.occurredAt,
          updatedAt: new Date(),
        },
      });
  }

  // 9. Fan-out INSERT loop. Per (event × subscriber):
  //    - skip if event.publishedAt < subscriber.target_since
  //    - skip if auto_passive flow AND subscriber.auto_import == false
  //      (cron passive cache hydration only — but we don't hydrate cache
  //       per-user since cache is global; effectively skip insert)
  //    - skip if user-triggered flow AND subscriber.auto_import == false
  //      AND subscriber.userId !== triggerUserId
  //      (other users' opt-out — only trigger user gets override)
  //    - skip if (userId, sourceId, externalId) already present
  let oldestFetchedOccurredAt: Date | null = null;
  const insertedByUser = new Map<string, number>();

  for (const ev of pollResult.events) {
    if (oldestFetchedOccurredAt === null || ev.occurredAt < oldestFetchedOccurredAt) {
      oldestFetchedOccurredAt = ev.occurredAt;
    }
    if (!ev.externalId) continue;

    for (const sub of subscribers) {
      if (sub.backfillTargetSince && ev.occurredAt < sub.backfillTargetSince) continue;

      const isTriggerUser = triggerUserId === sub.userId;
      if (flow === "auto_passive") {
        if (!sub.autoImport) continue;
      } else if (!isTriggerUser && !sub.autoImport) {
        continue;
      }

      const dedupKey = `${sub.userId}|${sub.id}|${ev.externalId}`;
      if (existingSet.has(dedupKey)) continue;

      // onConflictDoNothing — race-safe against parallel walks (e.g.,
      // user click + cron tick on the same channel that bypassed
      // singletonKey via worker-restart timing). The pre-SELECT above
      // is the optimistic fast path; this is the DB-level defense.
      const inserted = await db
        .insert(events)
        .values({
          userId: sub.userId,
          sourceId: sub.id,
          kind: "youtube_video",
          authorIsMe: sub.isOwnedByMe,
          occurredAt: ev.occurredAt,
          title: ev.title,
          url: ev.url,
          externalId: ev.externalId,
          metadata: ev.metadata ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length > 0) {
        insertedByUser.set(sub.userId, (insertedByUser.get(sub.userId) ?? 0) + 1);
      }
    }
  }

  // 9. Update channel state.
  if (oldestFetchedOccurredAt !== null) {
    if (
      channelState?.backfillOldestAt === null ||
      channelState?.backfillOldestAt === undefined ||
      oldestFetchedOccurredAt.getTime() < channelState.backfillOldestAt.getTime()
    ) {
      await markChannelBackfillFrontier(kind, channelKey, oldestFetchedOccurredAt);
    }
  }
  await setChannelBackfillPageToken(kind, channelKey, pollResult.nextPageToken ?? null);
  if (pollResult.endOfPlaylist) {
    await markChannelBackfillComplete(kind, channelKey);
  }
  await markChannelLastPolledAt(kind, channelKey);

  // 10. Audit — only for trigger user. Cron flows are traced via
  //     youtube_service_quota_usage operator pool table; no per-user row.
  if (triggerUserId) {
    const userInserted = insertedByUser.get(triggerUserId) ?? 0;
    await writeBackfillAudit({
      job,
      flow,
      kind,
      channelKey,
      triggerUserId,
      requestsUsed: pollResult.unitsUsed,
      eventsInserted: userInserted,
      sinceBranch: branch,
    });
  }

  logger.info(
    {
      jobId: job.id,
      kind,
      channelKey,
      flow,
      triggerUserId: triggerUserId ?? null,
      subscribers: subscribers.length,
      candidates: pollResult.events.length,
      insertedTotal: Array.from(insertedByUser.values()).reduce((a, b) => a + b, 0),
      requestsUsed: pollResult.unitsUsed,
      endOfPlaylist: pollResult.endOfPlaylist ?? false,
    },
    "youtube.backfill.channel: complete",
  );
}

async function writeBackfillAudit(args: {
  job: BackfillChannelJob;
  flow: BackfillFlow;
  kind: SourceKind;
  channelKey: string;
  triggerUserId: string;
  requestsUsed: number;
  eventsInserted: number;
  // Phase 03.0.3 P1 — forensics discriminator for the three-branch
  // since-derivation. Operator can run `SELECT metadata->>'since_branch',
  // COUNT(*) FROM audit_log WHERE action='source.refresh_content_requested'
  // GROUP BY 1` to verify the quota-burn invariant on prod (D-#29-2).
  sinceBranch: "exhausted" | "incremental" | "deep";
}): Promise<void> {
  // STRICT — cap counter sums requests_used + events_inserted from this row;
  // a swallowed insert silently undercounts user usage.
  await writeAuditStrict({
    userId: args.triggerUserId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind: args.kind,
      platform: args.kind,
      channel_key: args.channelKey,
      flow: args.flow,
      queue: "youtube.backfill.channel",
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.eventsInserted,
      since_branch: args.sinceBranch,
    },
  });
}

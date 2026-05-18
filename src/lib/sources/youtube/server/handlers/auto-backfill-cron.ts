// Auto-backfill daily cron handler.
//
// Picks up incomplete sources (backfill_complete=false) and enqueues
// passive channel backfill jobs into youtube.backfill.channel (with
// metadata.flow='auto_passive'). The worker handler distinguishes
// auto_passive from user-initiated flows:
//   - cache hydration in the shared youtube_videos table (always вЂ”
//     benefits the whole system; a future paste from another user gets a
//     cache hit).
//   - per-user events INSERT only when source.auto_import = true (user
//     opted in to passive feed updates). With auto_import=false вЂ” pure
//     cache work.
//
// Schedule: 03:00 Pacific daily, after the operator's quota reset at
// 00:00 PT. Pool fresh; minimal contention with active poll
// cron (every 6h UTC) and cold poll cron (5am PT).
//
// Priority gate: skip the entire tick when the cron pool is >= 50% used.
// This is lower priority than cold poll (skip >= 80%) and active poll
// (skip >= 95%) вЂ” stats polling protects freshness of existing videos;
// auto-backfill only adds historical depth. Under contention,
// auto-backfill steps aside first.
//
// Picker:
//   SELECT * FROM data_sources
//   WHERE backfill_complete = false
//     AND deleted_at IS NULL
//   ORDER BY last_polled_at NULLS FIRST
//   LIMIT 50;
//
// Idempotency: enqueue with singletonKey=`auto-backfill-${sourceId}` вЂ”
// pg-boss dedups per-source if a cron tick double-triggers. The job is
// processed in the shared channel-backfill queue with priority=0 (lowest);
// user-driven jobs at priority=1 go first.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { youtubeObservability } from "../observability.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

/** Cron pool usage threshold above which auto-backfill defers tick.
 *  Lower priority than cold poll (skip в‰Ґ0.80) and active poll (skip в‰Ґ0.95).
 *
 *  IMPORTANT: this is a FRACTION (0..1) matching `pctOfDaily` shape returned
 *  by `observability.quota.getDailyStats` (see adapter.ts ObservabilityDailyStats
 *  jsdoc). Pre-fix the constant was `50` and the comparison `pctOfDaily >= 50`
 *  never fired (max real fraction value is 1.0 < 50). Post-fix the gate
 *  actually defers ticks when operator quota is half-spent. */
const SKIP_THRESHOLD_FRACTION = 0.5;

/** Maximum sources picked per cron tick. Each enqueues one channel backfill job;
 *  worker processes serially. Bounded picker keeps round-robin fair across
 *  users with many incomplete sources. */
const MAX_PICK = 50;

interface AutoBackfillCronJob {
  id: string;
  data: object;
}

export async function handleAutoBackfillCron(
  job: AutoBackfillCronJob,
  boss: MinimalBoss,
): Promise<void> {
  // Priority gate вЂ” defer tick when overall operator quota under load.
  //
  // `pctOfDaily` aggregates ALL keys Г— ALL pools (cron 80% reservation +
  // user 20% reservation hit the same `youtube_service_quota_usage`
  // rows). The threshold being 50% means В«if ANY portion of operator's
  // daily budget is half-spent, auto-backfill cedesВ». This is
  // over-cautious vs. cron-pool-only check (50% cron + 0% user is 62.5%
  // of cron's slice, but 50% operator-wide) вЂ” that's intentional:
  // auto-backfill is the LOWEST priority work and should yield first
  // under contention.
  const stats = await youtubeObservability.quota.getDailyStats(new Date());
  if (stats.pctOfDaily >= SKIP_THRESHOLD_FRACTION) {
    logger.info(
      { jobId: job.id, pctOfDaily: stats.pctOfDaily, threshold: SKIP_THRESHOLD_FRACTION },
      "youtube.auto_backfill_cron: operator quota under load, deferring this tick",
    );
    return;
  }

  // Picker вЂ” incomplete sources, soft-deleted excluded, oldest-poll-first.
  //
  // CROSS-TENANT BY DESIGN (scheduler fan-out). This SELECT intentionally
  // walks all users' incomplete sources to enqueue passive backfill jobs.
  // The worker handler downstream re-applies tenant scope via
  // getSourceById(userId, sourceId) on each enqueued job, so cross-tenant
  // fan-out at the picker level is the correct architectural primitive.
  //
  // Fairness ordering: global oldest-poll-first wins. This is naturally
  // fair on a per-source basis: if user A has 1000 incomplete sources at
  // T-1d and user B has 1 incomplete source at T-1d+1m, user A wins this
  // tick (older), but once A's sources advance to today, B's becomes
  // the oldest and wins next tick. Power users (more sources = more
  // catch-up work) consume proportionally more cron budget вЂ” correct
  // semantics, not a fairness violation.
  //
  // NULLS FIRST вЂ” newly-onboarded sources (last_polled_at IS NULL) are
  // always the highest-priority pick. Ensures bootstrap walk happens
  // before any incremental refreshes.
  //
  // Channel-scoped picker: SELECT DISTINCT (kind, channel_key) from
  // data_source_channel_state where NOT complete, joined with
  // data_sources to ensure at least one active subscriber exists
  // (orphan channels with all subscribers soft-deleted are skipped).
  // Worker fans out to all subscribers per job.
  //
  // Cross-tenant by design вЂ” channel state is global; subscribers joined
  // for liveness check. The worker handler re-applies fan-out logic to
  // active subscribers (per-user filter on auto_import + target_since).
  // The tenant-scope ESLint rule does NOT fire here because the primary
  // SELECT is from data_source_channel_state (not in TENANT_TABLES); the
  // join against data_sources references userId only via its column path,
  // not as a WHERE filter вЂ” the rule's regex requires a userId filter on
  // tenant tables and this query intentionally has none.
  const candidates = await db
    .selectDistinct({
      kind: dataSourceChannelState.kind,
      channelKey: dataSourceChannelState.channelKey,
      lastPolledAt: dataSourceChannelState.lastPolledAt,
    })
    .from(dataSourceChannelState)
    .innerJoin(
      dataSources,
      and(
        eq(dataSources.kind, dataSourceChannelState.kind),
        eq(dataSources.channelId, dataSourceChannelState.channelKey),
        isNull(dataSources.deletedAt),
        eq(dataSources.needsReconnect, false),
      ),
    )
    .where(
      and(
        eq(dataSourceChannelState.backfillComplete, false),
        sql`${dataSourceChannelState.kind} = 'youtube_channel'`,
      ),
    )
    .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
    .limit(MAX_PICK);

  if (candidates.length === 0) {
    logger.info(
      { jobId: job.id },
      "youtube.auto_backfill_cron: no incomplete channels to pick вЂ” all caught up",
    );
    return;
  }

  let enqueued = 0;
  for (const ch of candidates) {
    try {
      await boss.send(
        QUEUES.YOUTUBE_BACKFILL_CHANNEL,
        {
          kind: ch.kind,
          channelKey: ch.channelKey,
          // No triggerUserId вЂ” cron flow consumes operator cron pool, no
          // per-user audit row, free fan-out to subscribers.
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "auto_passive",
        },
        // singletonKey by channelKey deduplicates concurrent triggers
        // (cron + user click on the same channel within 1h). singletonSeconds
        // covers worst-case scheduler-restart cycles for the daily cron.
        {
          singletonKey: `auto-backfill-${ch.channelKey}`,
          singletonSeconds: 3600,
          priority: 0,
        },
      );
      enqueued += 1;
    } catch (err) {
      logger.warn(
        {
          jobId: job.id,
          channelKey: ch.channelKey,
          err: String((err as Error)?.message ?? err),
        },
        "youtube.auto_backfill_cron: enqueue failed for channel; continuing",
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      pctOfDaily: stats.pctOfDaily,
      candidates: candidates.length,
      enqueued,
    },
    "youtube.auto_backfill_cron: tick complete",
  );
}

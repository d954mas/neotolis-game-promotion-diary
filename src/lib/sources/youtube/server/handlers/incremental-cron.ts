// Phase 03.0.1 Wave 3 — daily incremental cron handler.
//
// Closes the auto-backfill cron gap: once a channel reaches
// backfill_complete=true (full uploads playlist walked), the auto-backfill
// picker excludes it from future ticks. New uploads to that channel never
// land in subscribers' events feed until someone manually clicks
// "Pull new content". This handler runs daily and walks page 1 of EVERY
// channel with active auto_import subscribers — including completed
// channels — to discover new uploads cheaply.
//
// Cost: 1 quota unit / channel / day. Adapter walks page 1, sees items
// older than depthBoundIso (set to ~1 week ago to absorb timezone drift +
// channels that upload weekly batches), walkedPastSince=true, stops.
//
// Picker scope:
//   - kind = 'youtube_channel'
//   - has at least one active subscriber with auto_import = true and
//     deleted_at IS NULL (orphan / opt-out channels are skipped)
//   - NO filter on backfill_complete — that's the whole point. Both
//     incomplete and complete channels are walked.
//
// Coordinated with auto-backfill-cron (3:00 PT): incremental fires at
// 4:00 PT, 1 hour later. Auto-backfill prioritizes deep walks on
// incomplete channels; incremental tops up page 1 on everything. The
// pg-boss singletonKey=`incremental-${channelKey}` dedupes parallel ticks.
//
// Skip-gate: same pctOfDaily ≥ SKIP_THRESHOLD_FRACTION as auto-backfill —
// when operator quota is half-spent, daily incremental cedes (active
// poll-stats has higher priority for live-channel monitoring).

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { youtubeObservability } from "../observability.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

const SKIP_THRESHOLD_FRACTION = 0.5;
const MAX_PICK = 200;

/** How far back the incremental walk looks. Channels uploading 1-2 videos
 *  per day will hit this boundary on page 1; channels with bigger weekly
 *  batches still safely covered by the 50-item playlist page. Adapter's
 *  walkedPastSince=true on first page = 1 quota unit. */
const INCREMENTAL_WINDOW_DAYS = 14;

interface IncrementalCronJob {
  id: string;
  data: object;
}

interface MinimalBossSend extends MinimalBoss {
  send(
    queue: string,
    data: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<string | null>;
}

export async function handleIncrementalCron(
  job: IncrementalCronJob,
  boss: MinimalBossSend,
): Promise<void> {
  // Same priority gate as auto-backfill-cron — skip the entire tick when
  // operator pool is half-spent. Daily incremental is the lowest-priority
  // cron flow (active stats poll keeps live-channel monitoring fresh).
  const stats = await youtubeObservability.quota.getDailyStats(new Date());
  if (stats.pctOfDaily >= SKIP_THRESHOLD_FRACTION) {
    logger.info(
      { jobId: job.id, pctOfDaily: stats.pctOfDaily, threshold: SKIP_THRESHOLD_FRACTION },
      "youtube.incremental_cron: operator quota under load, deferring this tick",
    );
    return;
  }

  // Channel-scoped picker — DISTINCT (kind, channel_key) where at least
  // one subscriber with auto_import=true exists. backfill_complete is NOT
  // filtered — incremental cron explicitly targets ALL active channels
  // including completed ones (their auto-backfill picker excludes them).
  //
  // Cross-tenant by design — channel state is global. Worker handler
  // applies per-user fan-out filtering on auto_import + target_since.
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
        eq(dataSources.autoImport, true),
        eq(dataSources.needsReconnect, false),
      ),
    )
    .where(sql`${dataSourceChannelState.kind} = 'youtube_channel'`)
    .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
    .limit(MAX_PICK);

  if (candidates.length === 0) {
    logger.info(
      { jobId: job.id },
      "youtube.incremental_cron: no active channels to pick — all silent",
    );
    return;
  }

  // depthBoundIso = now - INCREMENTAL_WINDOW_DAYS. Adapter walks page 1
  // (50 newest videos), stops on walkedPastSince. 1 quota unit per channel.
  const depthBound = new Date(Date.now() - INCREMENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const depthBoundIso = depthBound.toISOString();

  let enqueued = 0;
  for (const ch of candidates) {
    try {
      await boss.send(
        QUEUES.YOUTUBE_BACKFILL_CHANNEL,
        {
          kind: ch.kind,
          channelKey: ch.channelKey,
          depthBoundIso,
          flow: "auto_passive",
        },
        // singletonKey by channelKey — dedupes against same-day re-ticks
        // AND against parallel auto-backfill-cron picks of the same channel.
        // singletonSeconds=3600 = 1h (cron tick interval shoulder).
        {
          singletonKey: `incremental-${ch.channelKey}`,
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
        "youtube.incremental_cron: enqueue failed for channel; continuing",
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      pctOfDaily: stats.pctOfDaily,
      candidates: candidates.length,
      enqueued,
      depthBoundIso,
    },
    "youtube.incremental_cron: tick complete",
  );
}

// reddit.poll.cron handler — age-tiered ongoing refresh (clone of twitter/server/
// handlers/poll-cron.ts, generalized over BOTH reddit kinds).
//
// Active + Cold + Warm collapse into one queue via boss.schedule({key}); this handler
// reads job.data.tier and dispatches.
//
// "Ongoing refresh" for Reddit: after backfill_complete the subject is NOT walked
// deeper. Each active/cold tick enqueues a page-1 INCREMENTAL walk (flow=auto_passive)
// on the per-kind backfill queue — the walker's incremental branch fetches K=2 pages
// (new posts since the frontier) AND re-polls those posts' metrics via writeSnapshot
// AND runs the Variant-A disappearance reconciliation. Cheap (≤2 credits/subject/day).
//
// Throttle skip-gate (D-15): the cron pool funds only non-essential background work.
//   - throttle >= "ninetyfive" → skip ALL background work.
//   - throttle >= "eighty"     → skip COLD (non-essential).

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { getSocialThrottleState } from "../quota.js";
import { TIER_BOUNDARY_COLD_MS } from "$lib/server/services/tier-resolver.js";
import { handleRedditWarmRefresh } from "./warm-refresh.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";
import type { PgColumn } from "drizzle-orm/pg-core";

const PLATFORM = "reddit";
const PROVIDER = "scrapecreators";
const MAX_PICK = 200;
const INCREMENTAL_WINDOW_DAYS = 14;

const KIND_CONFIG: Array<{ kind: "reddit_account" | "reddit_subreddit"; queue: string; subject: PgColumn }> = [
  { kind: "reddit_account", queue: QUEUES.REDDIT_BACKFILL_ACCOUNT, subject: redditPosts.author },
  {
    kind: "reddit_subreddit",
    queue: QUEUES.REDDIT_BACKFILL_SUBREDDIT,
    subject: redditPosts.subredditSlug,
  },
];

interface PollCronJob {
  id?: string;
  data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
}

export async function handleRedditPollCron(job: PollCronJob, boss: MinimalBoss): Promise<void> {
  const tier = job.data.tier;

  if (tier === "warm") {
    await handleRedditWarmRefresh(job);
    return;
  }

  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive") {
    logger.info({ jobId: job.id, tier, throttle }, "reddit.poll.cron: budget at 95% — skipping all");
    return;
  }
  if (throttle === "eighty" && tier === "cold") {
    logger.info({ jobId: job.id, tier, throttle }, "reddit.poll.cron: budget at 80% — skipping cold");
    return;
  }

  const activeBoundary = new Date(Date.now() - TIER_BOUNDARY_COLD_MS);
  const depthBoundIso = new Date(
    Date.now() - INCREMENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let totalEnqueued = 0;
  for (const cfg of KIND_CONFIG) {
    const newestPostExpr = sql<Date | null>`(
      SELECT MAX(${redditPosts.publishedAt})
      FROM ${redditPosts}
      WHERE ${cfg.subject} = ${dataSourceChannelState.channelKey}
    )`;

    // CROSS-TENANT BY DESIGN — channel state is global; the walker re-applies
    // per-subscriber fan-out gating (auto_import + target_since).
    const candidates = await db
      .selectDistinct({
        channelKey: dataSourceChannelState.channelKey,
        newestPost: newestPostExpr,
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
      .where(sql`${dataSourceChannelState.kind} = ${cfg.kind}`)
      .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
      .limit(MAX_PICK);

    const picked = candidates.filter((c) => {
      const isActive = c.newestPost === null || new Date(c.newestPost) >= activeBoundary;
      return tier === "active" ? isActive : !isActive;
    });

    for (const ch of picked) {
      try {
        await boss.send(
          cfg.queue,
          { kind: cfg.kind, channelKey: ch.channelKey, depthBoundIso, flow: "auto_passive" },
          { singletonKey: `reddit-poll-${tier}-${cfg.kind}-${ch.channelKey}`, singletonSeconds: 3600, priority: 0 },
        );
        totalEnqueued += 1;
      } catch (err) {
        logger.warn(
          { jobId: job.id, channelKey: ch.channelKey, kind: cfg.kind, err: String((err as Error)?.message ?? err) },
          "reddit.poll.cron: enqueue failed; continuing",
        );
      }
    }
  }

  logger.info({ jobId: job.id, tier, throttle, enqueued: totalEnqueued }, "reddit.poll.cron: tick complete");
}

// instagram.poll.cron handler — age-tiered ongoing refresh (BACK-03 / D-15).
//
// Active + Cold collapse into one queue via boss.schedule({key}) (pg-boss
// multiple-schedules-per-queue); this handler reads job.data.tier and dispatches.
//
// What "ongoing refresh" means for IG (BACK-03): after backfill_complete, the
// account is NOT walked deeper. Each tick enqueues a PAGE-1 incremental walk
// (flow='auto_passive') on instagram.backfill.account — the walker's incremental
// branch fetches page 1 of each feed (new posts since the frontier) AND re-polls
// those posts' metrics via writeSnapshot (every post on the page gets a fresh
// snapshot). It does NOT advance the historical cursor. So a single page-1 walk
// is both "new posts since last poll" and "re-poll active posts" in one cheap
// page (D-18: 1 credit/feed).
//
// Throttle skip-gate (D-15): the cron pool is non-essential.
//   - getSocialThrottleState >= "eighty"  → skip COLD + auto-import + backfill
//     (only the active tier's freshest accounts still poll, and only if not
//     ninetyfive).
//   - getSocialThrottleState >= "ninetyfive" → skip ALL background work.
//
// Picker scope: accounts with at least one active, non-needs-reconnect
// subscriber. Active tier picks accounts whose newest post is within the active
// window; cold tier picks the rest (re-polled less often). Frozen posts are
// never re-polled — resolveTier classifies them off published_at and the
// walker's date window naturally excludes them.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { getSocialThrottleState } from "../quota.js";
import { TIER_BOUNDARY_COLD_MS } from "$lib/server/services/tier-resolver.js";
import { handleInstagramWarmRefresh } from "./warm-refresh.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

const PLATFORM = "instagram";
const PROVIDER = "scrapecreators";
const KIND = "instagram_account" as const;
const MAX_PICK = 200;

/** How far back the incremental walk's date window reaches. Comfortably covers
 *  weekly-posting accounts on page 1; the walker's walkedPastSince logic stops
 *  it at 1 page/feed. */
const INCREMENTAL_WINDOW_DAYS = 14;

interface PollCronJob {
  id?: string;
  data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
}

export async function handleInstagramPollCron(job: PollCronJob, boss: MinimalBoss): Promise<void> {
  const tier = job.data.tier;

  // Warm per-post auto-refresh (#70) is a DIFFERENT operation from the account-
  // level page-1 walk below (it enqueues service_post rows; it does not walk
  // feeds). Branch BEFORE the account-picker SELECT so none of the active/cold
  // machinery runs, and it carries its own throttle skip-gate.
  if (tier === "warm") {
    await handleInstagramWarmRefresh(job);
    return;
  }

  // Throttle skip-gate. The cron pool funds only non-essential background work.
  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "instagram.poll.cron: budget at 95% — skipping all background work",
    );
    return;
  }
  if (throttle === "eighty" && tier === "cold") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "instagram.poll.cron: budget at 80% — skipping cold tier (non-essential)",
    );
    return;
  }

  // Active window boundary: a post within the cold-tier boundary is "active".
  const activeBoundary = new Date(Date.now() - TIER_BOUNDARY_COLD_MS);

  // Picker — accounts with at least one live subscriber. Active tier: the
  // account's newest cached post is within the active window. Cold tier: the
  // newest post is older (or unknown). The newest-post subquery reads
  // instagram_posts (public-data); the join enforces a live subscriber exists.
  //
  // CROSS-TENANT BY DESIGN — channel state is global; the worker re-applies
  // per-subscriber fan-out gating (auto_import + target_since).
  const newestPostExpr = sql<Date | null>`(
    SELECT MAX(${instagramPosts.publishedAt})
    FROM ${instagramPosts}
    WHERE ${instagramPosts.accountId} = ${dataSourceChannelState.channelKey}
  )`;

  const candidates = await db
    .selectDistinct({
      channelKey: dataSourceChannelState.channelKey,
      lastPolledAt: dataSourceChannelState.lastPolledAt,
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
    .where(sql`${dataSourceChannelState.kind} = 'instagram_account'`)
    .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
    .limit(MAX_PICK);

  // Partition by tier off the newest cached post. An account with no cached
  // posts yet (newestPost null) is treated as ACTIVE — it needs a first/early
  // poll regardless of cadence.
  const picked = candidates.filter((c) => {
    const isActive = c.newestPost === null || new Date(c.newestPost) >= activeBoundary;
    return tier === "active" ? isActive : !isActive;
  });

  if (picked.length === 0) {
    logger.info({ jobId: job.id, tier }, "instagram.poll.cron: no accounts to poll this tier");
    return;
  }

  // Page-1 incremental walk per account on the cron pool (auto_passive, no
  // triggerUserId → cron budget, no per-user audit). depthBoundIso = the
  // incremental window; the walker's incremental branch fetches page 1 only and
  // does NOT walk deeper (BACK-03).
  const depthBoundIso = new Date(
    Date.now() - INCREMENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let enqueued = 0;
  for (const ch of picked) {
    try {
      await boss.send(
        QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
        {
          kind: KIND,
          channelKey: ch.channelKey,
          depthBoundIso,
          flow: "auto_passive",
        },
        {
          singletonKey: `instagram-poll-${tier}-${ch.channelKey}`,
          singletonSeconds: 3600,
          priority: 0,
        },
      );
      enqueued += 1;
    } catch (err) {
      logger.warn(
        { jobId: job.id, channelKey: ch.channelKey, err: String((err as Error)?.message ?? err) },
        "instagram.poll.cron: enqueue failed for account; continuing",
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      tier,
      throttle,
      candidates: candidates.length,
      picked: picked.length,
      enqueued,
    },
    "instagram.poll.cron: tick complete",
  );
}

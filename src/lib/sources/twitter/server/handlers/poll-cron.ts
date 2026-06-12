// twitter.poll.cron handler — age-tiered ongoing refresh (clone of tiktok/server/
// handlers/poll-cron.ts, single-feed, twitterapi.io provider).
//
// Active + Cold + Warm collapse into one queue via boss.schedule({key}); this
// handler reads job.data.tier and dispatches.
//
// What "ongoing refresh" means for Twitter (BACK-03): after backfill_complete, the
// account is NOT walked deeper. Each active/cold tick enqueues a PAGE-1 incremental
// walk (flow='auto_passive') on twitter.backfill.account — the walker's incremental
// branch fetches page 1 (new tweets since the frontier) AND re-polls those tweets'
// metrics via writeSnapshot. It does NOT advance the historical cursor. So a single
// page-1 walk is both "new tweets since last poll" and "re-poll active tweets" in
// one cheap page (1 credit).
//
// Throttle skip-gate (D-15): the cron pool is non-essential.
//   - getSocialThrottleState >= "eighty"     → skip COLD + auto-import + backfill.
//   - getSocialThrottleState >= "ninetyfive" → skip ALL background work.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { twitterPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { QUEUES } from "$lib/server/queues.js";
import { getSocialThrottleState } from "../quota.js";
import { TIER_BOUNDARY_COLD_MS } from "$lib/server/services/tier-resolver.js";
import { handleTwitterWarmRefresh } from "./warm-refresh.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";

const PLATFORM = "twitter";
const PROVIDER = "twitterapi.io";
const KIND = "twitter_account" as const;
const MAX_PICK = 200;

/** How far back the incremental walk's date window reaches. Comfortably covers
 *  weekly-posting accounts on page 1; the walker's window logic stops it at 1
 *  page. */
const INCREMENTAL_WINDOW_DAYS = 14;

interface PollCronJob {
  id?: string;
  data: { tier: "active" | "cold" | "warm" } & Record<string, unknown>;
}

export async function handleTwitterPollCron(job: PollCronJob, boss: MinimalBoss): Promise<void> {
  const tier = job.data.tier;

  // Warm per-post auto-refresh is a DIFFERENT operation from the account-level
  // page-1 walk below (it enqueues service_post rows; it does not walk feeds).
  // Branch BEFORE the account-picker SELECT so none of the active/cold machinery
  // runs, and it carries its own throttle skip-gate.
  if (tier === "warm") {
    await handleTwitterWarmRefresh(job);
    return;
  }

  // Throttle skip-gate. The cron pool funds only non-essential background work.
  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "twitter.poll.cron: budget at 95% — skipping all background work",
    );
    return;
  }
  if (throttle === "eighty" && tier === "cold") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "twitter.poll.cron: budget at 80% — skipping cold tier (non-essential)",
    );
    return;
  }

  // Active window boundary: a tweet within the cold-tier boundary is "active".
  const activeBoundary = new Date(Date.now() - TIER_BOUNDARY_COLD_MS);

  // Picker — accounts with at least one live subscriber. Active tier: the account's
  // newest cached tweet is within the active window. Cold tier: the newest tweet is
  // older (or unknown). The newest-tweet subquery reads twitter_posts (public-data);
  // the join enforces a live subscriber exists.
  //
  // CROSS-TENANT BY DESIGN — channel state is global; the worker re-applies
  // per-subscriber fan-out gating (auto_import + target_since).
  const newestPostExpr = sql<Date | null>`(
    SELECT MAX(${twitterPosts.publishedAt})
    FROM ${twitterPosts}
    WHERE ${twitterPosts.accountId} = ${dataSourceChannelState.channelKey}
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
    .where(sql`${dataSourceChannelState.kind} = 'twitter_account'`)
    .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
    .limit(MAX_PICK);

  // Partition by tier off the newest cached tweet. An account with no cached tweets
  // yet (newestPost null) is treated as ACTIVE — it needs a first/early poll.
  const picked = candidates.filter((c) => {
    const isActive = c.newestPost === null || new Date(c.newestPost) >= activeBoundary;
    return tier === "active" ? isActive : !isActive;
  });

  if (picked.length === 0) {
    logger.info({ jobId: job.id, tier }, "twitter.poll.cron: no accounts to poll this tier");
    return;
  }

  // Page-1 incremental walk per account on the cron pool (auto_passive, no
  // triggerUserId → cron budget, no per-user audit). depthBoundIso = the incremental
  // window; the walker's incremental branch fetches page 1 only. singletonKey +
  // singletonSeconds dedupe so a slow account's prior walk never piles up — part of
  // the QPS pacing (one in-flight walk per account, one provider page per tick).
  const depthBoundIso = new Date(
    Date.now() - INCREMENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let enqueued = 0;
  for (const ch of picked) {
    try {
      await boss.send(
        QUEUES.TWITTER_BACKFILL_ACCOUNT,
        {
          kind: KIND,
          channelKey: ch.channelKey,
          depthBoundIso,
          flow: "auto_passive",
        },
        {
          singletonKey: `twitter-poll-${tier}-${ch.channelKey}`,
          singletonSeconds: 3600,
          priority: 0,
        },
      );
      enqueued += 1;
    } catch (err) {
      logger.warn(
        { jobId: job.id, channelKey: ch.channelKey, err: String((err as Error)?.message ?? err) },
        "twitter.poll.cron: enqueue failed for account; continuing",
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
    "twitter.poll.cron: tick complete",
  );
}

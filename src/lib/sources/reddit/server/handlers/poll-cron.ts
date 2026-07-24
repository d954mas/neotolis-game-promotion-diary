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
import { getSocialProvider } from "../provider/registry.js";
import { redditWalkSingletonKey } from "../backfill-state.js";
import { TIER_BOUNDARY_COLD_MS } from "$lib/server/services/tier-resolver.js";
import type { MinimalBoss } from "$lib/sources/adapter.js";
import type { PgColumn } from "drizzle-orm/pg-core";

const PLATFORM = "reddit";
const PROVIDER = "scrapecreators";
const MAX_PICK = 200;
const INCREMENTAL_WINDOW_DAYS = 14;

const KIND_CONFIG: Array<{
  kind: "reddit_account" | "reddit_subreddit";
  queue: string;
  subject: PgColumn;
}> = [
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

  // D-08 isolation: when Reddit is OFF (the default) skip ALL poll work — no candidate
  // SELECT, no enqueue of walk jobs that would only degrade to no-ops. (The GDPR
  // deletion-propagation cron is deliberately NOT gated: pending purges must still fire
  // even after the operator disables Reddit.)
  if (getSocialProvider("reddit") === null) {
    logger.info({ jobId: job.id, tier }, "reddit.poll.cron: provider not configured; skipping");
    return;
  }

  if (tier === "warm") {
    // Reddit warm lane DISABLED (review fix, operator call 2026-07-22):
    // ScrapeCreators has no lookup-by-id, so the warm catch resolves a post from
    // its subreddit's page 1 — and a post that fell off the daily walk is almost
    // never there. Each attempt burned a credit for a not_found snapshot. The
    // daily walk keeps recent posts fresh; manual Refresh-Now stays available.
    // This branch stays as a defensive no-op against a stale pg-boss `warm`
    // schedule persisted by a pre-disable deploy. Re-enable only if the provider
    // ships a single-post-by-id endpoint.
    logger.info({ jobId: job.id }, "reddit.poll.cron: warm lane disabled; no-op");
    return;
  }

  const throttle = await getSocialThrottleState(PLATFORM, PROVIDER);
  if (throttle === "ninetyfive") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "reddit.poll.cron: budget at 95% — skipping all",
    );
    return;
  }
  if (throttle === "eighty" && tier === "cold") {
    logger.info(
      { jobId: job.id, tier, throttle },
      "reddit.poll.cron: budget at 80% — skipping cold",
    );
    return;
  }

  const activeBoundary = new Date(Date.now() - TIER_BOUNDARY_COLD_MS);
  const depthBoundIso = new Date(
    Date.now() - INCREMENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let totalEnqueued = 0;
  for (const cfg of KIND_CONFIG) {
    // Case-insensitive match: reddit_posts.author is stored verbatim (case-preserving) but
    // channelKey is lowercased. LOWER() is a no-op for the already-lowercase subredditSlug.
    // Without it a mixed-case account has newestPost=NULL → mis-tiered "active" forever.
    const newestPostExpr = sql<Date | null>`(
      SELECT MAX(${redditPosts.publishedAt})
      FROM ${redditPosts}
      WHERE LOWER(${cfg.subject}) = ${dataSourceChannelState.channelKey}
    )`;

    // Tier predicate lives in SQL, BEFORE ORDER BY/LIMIT — NOT a post-LIMIT JS filter.
    // With the filter applied after `LIMIT 200`, an opposite-tier prefix (200 rows of
    // the other tier, oldest-polled first) could starve the requested tier forever: the
    // wanted rows never enter the 200-row window. Pushing the predicate into WHERE means
    // the LIMIT counts only the requested tier. active = newest post recent OR unknown
    // (null published_at); cold = a known-older newest post.
    const tierPredicate =
      tier === "active"
        ? sql`(${newestPostExpr} IS NULL OR ${newestPostExpr} >= ${activeBoundary})`
        : sql`(${newestPostExpr} IS NOT NULL AND ${newestPostExpr} < ${activeBoundary})`;

    // CROSS-TENANT BY DESIGN — channel state is global; the walker re-applies
    // per-subscriber fan-out gating (auto_import + target_since).
    const candidates = await db
      .selectDistinct({
        channelKey: dataSourceChannelState.channelKey,
        // Projected because SELECT DISTINCT requires every ORDER BY expr in the list.
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
      .where(and(sql`${dataSourceChannelState.kind} = ${cfg.kind}`, tierPredicate))
      .orderBy(sql`${dataSourceChannelState.lastPolledAt} ASC NULLS FIRST`)
      .limit(MAX_PICK);

    for (const ch of candidates) {
      try {
        await boss.send(
          cfg.queue,
          { kind: cfg.kind, channelKey: ch.channelKey, depthBoundIso, flow: "auto_passive" },
          {
            // Channel-scoped singleton shared with initial/manual/widening (NOT a
            // per-tier `singletonSeconds` throttle): a plain key dedupes a cron tick
            // against an already-running manual/initial walk of the same channel, so
            // the two never double-spend. Mixing singletonSeconds here would defeat that
            // (different singleton_on ⇒ no cross-producer dedup — see the helper).
            singletonKey: redditWalkSingletonKey(cfg.kind, ch.channelKey),
            priority: 0,
          },
        );
        totalEnqueued += 1;
      } catch (err) {
        logger.warn(
          {
            jobId: job.id,
            channelKey: ch.channelKey,
            kind: cfg.kind,
            err: String((err as Error)?.message ?? err),
          },
          "reddit.poll.cron: enqueue failed; continuing",
        );
      }
    }
  }

  logger.info(
    { jobId: job.id, tier, throttle, enqueued: totalEnqueued },
    "reddit.poll.cron: tick complete",
  );
}

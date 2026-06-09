// Warm-post eligibility for Telegram auto-refresh (mirrors
// instagram/warm-eligibility.ts, guardrails STRIPPED — Telegram is free).
//
// A post is "warm" — it gets a single-post ?embed=1 refresh via the service_post
// lane — while it is YOUNG and has gone STALE:
//   - published_at > now − TELEGRAM_WARM_WINDOW_DAYS  (the first week of a post's
//     life, where metrics move + wishlist correlation matters; older → frozen)
//   - last_polled_at IS NULL OR < now − TELEGRAM_WARM_STALENESS_HOURS  (the gate:
//     while a post is on the ~20-post t.me/s listing the FREE 6h listing poll
//     keeps last_polled_at fresh, so the predicate excludes it — 12h > the 6h
//     listing interval. Once the post scrolls OFF the listing it goes stale and
//     the warm lane tops it up. Self-paces to ~1 refresh/12h.)
//
// Terminal/failure exclusion (clean — Telegram has NO budget collapsed into a
// status, the IG auth_error nuance does NOT apply here):
//   - exclude genuinely-terminal not_found/private (post is gone — stop fetching)
//   - bound transient churn via poll_failure_count: a persistent failure stops
//     after TELEGRAM_WARM_MAX_FAILURES tries; a blip self-heals (poll_failure_count
//     resets to 0 on the next ok poll — snapshots.ts).
//
// NO throttle/budget/cost gate, NO provider gate, NO user-quota cap. Telegram is
// FREE — that is the whole point of Phase 9 vs the IG warm lane (which carries
// getSocialThrottleState / getSocialProvider / reserveSocialCredits gates the
// strip-list removes here).
//
// Cross-tenant by design (mirrors poll-eligibility.ts): the scheduler fan-out is
// service-wide; telegram_posts is public-data; the per-post writeTelegramSnapshot
// downstream is public-data. ONE row per post regardless of how many tenants
// reference it (a single single-post fetch serves all — no per-tenant fan-out).

import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { events } from "$lib/server/db/schema/events.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const TELEGRAM_WARM_WINDOW_DAYS = env.TELEGRAM_WARM_WINDOW_DAYS;

/**
 * Resolve the distinct post_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle, no throttle gate (the
 * producer just enqueues; Telegram is free so there is nothing to gate on).
 */
export async function selectWarmTelegramPostIds(now: Date): Promise<string[]> {
  const windowStart = new Date(now.getTime() - env.TELEGRAM_WARM_WINDOW_DAYS * DAY_MS);
  const staleBefore = new Date(now.getTime() - env.TELEGRAM_WARM_STALENESS_HOURS * HOUR_MS);

  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; one warm tick batches eligible posts across ALL tenants. telegram_posts is public-data; the per-post writeTelegramSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({ postId: telegramPosts.postId })
    .from(events)
    .innerJoin(telegramPosts, eq(events.externalId, telegramPosts.postId))
    .where(
      and(
        sql`${events.kind} = 'telegram_post'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        // Young: within the warm window. NULL published_at (pre-backfill
        // 'pending') is excluded — we don't know the age yet; the listing poll
        // fills it.
        gt(telegramPosts.publishedAt, windowStart),
        // Stale: never polled, or last poll older than the staleness gate.
        or(isNull(telegramPosts.lastPolledAt), lt(telegramPosts.lastPolledAt, staleBefore)),
        // Terminal exclusion — clean not_found/private (post is gone).
        sql`(${telegramPosts.lastPollStatus} IS NULL OR ${telegramPosts.lastPollStatus} NOT IN ('not_found','private'))`,
        // Bounded-failure exclusion — stop churning on a persistent failure.
        lt(telegramPosts.pollFailureCount, env.TELEGRAM_WARM_MAX_FAILURES),
      ),
    );
  return rows.map((r) => r.postId);
}

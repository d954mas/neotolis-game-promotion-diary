// Warm-post eligibility for TikTok auto-refresh (clone of instagram/server/
// warm-eligibility.ts, retargeted to tiktok_posts + the TIKTOK_WARM_* envs).
//
// A post is "warm" — it gets a PAID single-post refresh ~1×/day via the
// service_post lane — while it is YOUNG and has gone STALE:
//   - published_at > now − TIKTOK_WARM_WINDOW_DAYS  (the first week of a post's
//     life, where metrics move + wishlist correlation matters; older → frozen)
//   - last_polled_at IS NULL OR < now − TIKTOK_WARM_STALENESS_HOURS  (the gate:
//     while a post is on page-1 of the account feed the FREE daily account poll
//     keeps last_polled_at fresh, so the predicate excludes it — we do NOT pay for
//     what the free poll already covers. Once it rolls off page-1 it goes stale and
//     the warm lane tops it up. Self-paces to ~1×/day.)
//
// Terminal/failure exclusion — TikTok-OWN (mirrors IG #70 P1-A): the HTTP seam
// collapses transient (5xx/timeout/network) AND operator-issue (budget-exhausted)
// into last_poll_status='auth_error'. Excluding auth_error wholesale would FREEZE
// a post out of auto-refresh on a single blip. So:
//   - exclude only genuinely-terminal not_found/private (post is gone — stop paying)
//   - bound transient churn via poll_failure_count: a persistent failure stops after
//     TIKTOK_WARM_MAX_FAILURES tries; a blip self-heals (poll_failure_count resets
//     to 0 on the next ok poll — snapshots.ts).
//
// Cross-tenant by design: the scheduler fan-out is service-wide; tiktok_posts is
// public-data; the per-post writeSnapshot downstream is public-data. ONE row per
// post regardless of how many tenants reference it.

import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { events } from "$lib/server/db/schema/events.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Resolve the distinct aweme_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectWarmInstagramPostIds.
 */
export async function selectWarmTikTokPostIds(now: Date): Promise<string[]> {
  const windowStart = new Date(now.getTime() - env.TIKTOK_WARM_WINDOW_DAYS * DAY_MS);
  const staleBefore = new Date(now.getTime() - env.TIKTOK_WARM_STALENESS_HOURS * HOUR_MS);

  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; one warm tick batches eligible posts across ALL tenants. tiktok_posts is public-data; the per-post writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({ awemeId: tiktokPosts.awemeId })
    .from(events)
    .innerJoin(tiktokPosts, eq(events.externalId, tiktokPosts.awemeId))
    .where(
      and(
        sql`${events.kind} = 'tiktok_post'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        // Young: within the warm window. NULL published_at (pre-backfill 'pending')
        // is excluded — we don't know the age yet; the account poll fills it.
        gt(tiktokPosts.publishedAt, windowStart),
        // Stale: never polled, or last poll older than the staleness gate.
        or(isNull(tiktokPosts.lastPolledAt), lt(tiktokPosts.lastPolledAt, staleBefore)),
        // Terminal exclusion — TikTok-own (not_found/private only).
        sql`(${tiktokPosts.lastPollStatus} IS NULL OR ${tiktokPosts.lastPollStatus} NOT IN ('not_found','private'))`,
        // Bounded-failure exclusion — stop churning credits on a persistent failure.
        lt(tiktokPosts.pollFailureCount, env.TIKTOK_WARM_MAX_FAILURES),
      ),
    );
  return rows.map((r) => r.awemeId);
}

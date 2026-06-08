// Warm-post eligibility for Instagram auto-refresh (#70).
//
// A post is "warm" — it gets a PAID single-post refresh ~1×/day via the
// service_post lane — while it is YOUNG and has gone STALE:
//   - published_at > now − INSTAGRAM_WARM_WINDOW_DAYS  (the first week of a post's
//     life, where metrics move + wishlist correlation matters; older → frozen)
//   - last_polled_at IS NULL OR < now − INSTAGRAM_WARM_STALENESS_HOURS  (the gate:
//     while a post is on page-1 of the account feed the FREE daily account poll
//     keeps last_polled_at fresh, so the predicate excludes it — we do NOT pay for
//     what the free poll already covers. Once it rolls off page-1 it goes stale and
//     the warm lane tops it up. Self-paces to ~1×/day.)
//
// Terminal/failure exclusion — IG-OWN, deliberately NOT YouTube's
// UNAVAILABLE_POLL_STATUSES (#70 P1-A): IG's HTTP seam collapses transient (5xx/
// timeout/network) AND operator-issue (budget-exhausted) into
// last_poll_status='auth_error'. Excluding auth_error wholesale (as YouTube's
// constant does, for its permanent-key-rejection semantics) would FREEZE a post
// out of auto-refresh on a single blip. So:
//   - exclude only genuinely-terminal not_found/private (post is gone — stop paying)
//   - bound transient churn via poll_failure_count: a persistent failure stops after
//     INSTAGRAM_WARM_MAX_FAILURES tries; a blip self-heals (poll_failure_count resets
//     to 0 on the next ok poll — snapshots.ts).
//
// Cross-tenant by design (mirrors poll-eligibility.ts): the scheduler fan-out is
// service-wide; instagram_posts is public-data; the per-post writeSnapshot
// downstream is public-data. ONE row per post regardless of how many tenants
// reference it (a single single-post fetch serves all — no per-tenant fan-out).

import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { events } from "$lib/server/db/schema/events.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Resolve the distinct post_ids eligible for a warm auto-refresh now. Returns []
 * when nothing is due. Pure read — no queue handle (the scheduler wraps it in the
 * throttle gate + enqueue), mirroring selectEligibleVideoIds.
 */
export async function selectWarmInstagramPostIds(now: Date): Promise<string[]> {
  const windowStart = new Date(now.getTime() - env.INSTAGRAM_WARM_WINDOW_DAYS * DAY_MS);
  const staleBefore = new Date(now.getTime() - env.INSTAGRAM_WARM_STALENESS_HOURS * HOUR_MS);

  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; one warm tick batches eligible posts across ALL tenants. instagram_posts is public-data; the per-post writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({ postId: instagramPosts.postId })
    .from(events)
    .innerJoin(instagramPosts, eq(events.externalId, instagramPosts.postId))
    .where(
      and(
        sql`${events.kind} = 'instagram_post'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        // Young: within the warm window. NULL published_at (pre-backfill 'pending')
        // is excluded — we don't know the age yet; the account poll fills it.
        gt(instagramPosts.publishedAt, windowStart),
        // Stale: never polled, or last poll older than the staleness gate.
        or(isNull(instagramPosts.lastPolledAt), lt(instagramPosts.lastPolledAt, staleBefore)),
        // Terminal exclusion — IG-own (not_found/private only). See header (#70 P1-A).
        sql`(${instagramPosts.lastPollStatus} IS NULL OR ${instagramPosts.lastPollStatus} NOT IN ('not_found','private'))`,
        // Bounded-failure exclusion — stop churning credits on a persistent failure.
        lt(instagramPosts.pollFailureCount, env.INSTAGRAM_WARM_MAX_FAILURES),
      ),
    );
  return rows.map((r) => r.postId);
}

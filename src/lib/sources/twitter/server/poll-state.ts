// Twitter/X poll-state reader (BACK-04 tier overlay feed) — clone of tiktok/server/
// poll-state.ts.
//
// Implements SourceAdapter.fetchPollStateMap for the Twitter adapter. dto.ts's
// cross-source overlayPollStateOnEvents iterates allAdapters and merges per-adapter
// results, then calls the PLATFORM-AGNOSTIC resolveTier
// (src/lib/server/services/tier-resolver.ts) with the returned publishedAt /
// lastPollStatus / lastPolledAt to pick the PollingBadge variant. Twitter posts
// therefore tier (active/cold/frozen/pending/unavailable) EXACTLY like
// YouTube/IG/TikTok — there is no Twitter-specific tier logic, by design (BACK-04).
//
// twitter_posts is PUBLIC-DATA — no user_id column, identical across tenants. Lookup
// is keyed on the tweet_id PK only (already in the ESLint tenant-scope allowlist,
// Plan 01). The `_userId` parameter is present for contract symmetry but unused: the
// tenant guarantee comes from the caller's upstream events SELECT.
//
// published_at drives the tier (BACK-04): a "I logged a promo today for a year-old
// tweet" paste correctly resolves Cold/Frozen off the TWEET's created_at, not the
// event's occurred_at.

import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { twitterPosts } from "$lib/server/db/schema/index.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

export async function twitterFetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;

  const rows = await db
    .select({
      tweetId: twitterPosts.tweetId,
      publishedAt: twitterPosts.publishedAt,
      lastPolledAt: twitterPosts.lastPolledAt,
      lastPollStatus: twitterPosts.lastPollStatus,
    })
    .from(twitterPosts)
    .where(inArray(twitterPosts.tweetId, [...externalIds]));
  for (const r of rows) {
    map.set(r.tweetId, {
      publishedAt: r.publishedAt,
      lastPolledAt: r.lastPolledAt,
      lastPollStatus: r.lastPollStatus,
    });
  }
  return map;
}

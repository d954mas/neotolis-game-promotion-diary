// Reddit poll-state reader (BACK-04 tier overlay feed) — clone of twitter/server/
// poll-state.ts.
//
// Implements SourceAdapter.fetchPollStateMap for the Reddit adapter. dto.ts's
// cross-source overlayPollStateOnEvents iterates allAdapters and merges per-adapter
// results, then calls the PLATFORM-AGNOSTIC resolveTier
// (src/lib/server/services/tier-resolver.ts) with the returned publishedAt /
// lastPollStatus / lastPolledAt to pick the PollingBadge variant. Reddit posts
// therefore tier (active/cold/frozen/pending/unavailable) EXACTLY like
// YouTube/IG/TikTok/Twitter — there is no Reddit-specific tier logic, by design.
//
// reddit_posts is PUBLIC-DATA — no user_id column, identical across tenants. Lookup
// is keyed on the post_id PK only (allowlisted, Plan 02). The `_userId` parameter is
// present for contract symmetry but unused: the tenant guarantee comes from the
// caller's upstream events SELECT.
//
// published_at drives the tier (BACK-04): a "I logged a promo today for an old post"
// paste correctly resolves Cold/Frozen off the POST's created_at, not the event's
// occurred_at.

import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

export async function redditFetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;

  const rows = await db
    .select({
      postId: redditPosts.postId,
      publishedAt: redditPosts.publishedAt,
      lastPolledAt: redditPosts.lastPolledAt,
      lastPollStatus: redditPosts.lastPollStatus,
    })
    .from(redditPosts)
    .where(inArray(redditPosts.postId, [...externalIds]));
  for (const r of rows) {
    map.set(r.postId, {
      publishedAt: r.publishedAt,
      lastPolledAt: r.lastPolledAt,
      lastPollStatus: r.lastPollStatus,
    });
  }
  return map;
}

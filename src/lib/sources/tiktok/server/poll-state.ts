// TikTok poll-state reader (BACK-04 tier overlay feed) — clone of instagram/
// server/poll-state.ts.
//
// Implements SourceAdapter.fetchPollStateMap for the TikTok adapter. dto.ts's
// cross-source overlayPollStateOnEvents iterates allAdapters and merges per-adapter
// results, then calls the PLATFORM-AGNOSTIC resolveTier
// (src/lib/server/services/tier-resolver.ts) with the returned publishedAt /
// lastPollStatus / lastPolledAt to pick the PollingBadge variant. TikTok posts
// therefore tier (active/cold/frozen/pending/unavailable) EXACTLY like
// YouTube/IG videos — there is no TikTok-specific tier logic, by design (BACK-04).
//
// tiktok_posts is PUBLIC-DATA — no user_id column, identical across tenants.
// Lookup is keyed on the aweme_id PK only (already in the ESLint tenant-scope
// allowlist, Plan 01). The `_userId` parameter is present for contract symmetry but
// unused: the tenant guarantee comes from the caller's upstream events SELECT.
//
// published_at drives the tier (BACK-04): a "I logged a promo today for a year-old
// video" paste correctly resolves Cold/Frozen off the POST's create_time, not the
// event's occurred_at.

import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

export async function tiktokFetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;

  const rows = await db
    .select({
      awemeId: tiktokPosts.awemeId,
      publishedAt: tiktokPosts.publishedAt,
      lastPolledAt: tiktokPosts.lastPolledAt,
      lastPollStatus: tiktokPosts.lastPollStatus,
    })
    .from(tiktokPosts)
    .where(inArray(tiktokPosts.awemeId, [...externalIds]));
  for (const r of rows) {
    map.set(r.awemeId, {
      publishedAt: r.publishedAt,
      lastPolledAt: r.lastPolledAt,
      lastPollStatus: r.lastPollStatus,
    });
  }
  return map;
}

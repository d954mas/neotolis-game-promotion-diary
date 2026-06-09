// Telegram poll-state reader (tier overlay feed).
//
// Implements SourceAdapter.fetchPollStateMap for the Telegram adapter. dto.ts's
// cross-source overlayPollStateOnEvents iterates allAdapters and merges
// per-adapter results, then calls the PLATFORM-AGNOSTIC resolveTier
// (src/lib/server/services/tier-resolver.ts) with the returned publishedAt /
// lastPollStatus / lastPolledAt to pick the PollingBadge variant. Telegram
// posts therefore tier (active/cold/frozen/pending/unavailable) EXACTLY like
// YouTube videos / IG posts — there is no Telegram-specific tier logic, by
// design.
//
// telegram_posts is PUBLIC-DATA — no user_id column, identical across tenants.
// Lookup is keyed on the post_id PK only (already in the ESLint tenant-scope
// allowlist, Plan 01). The `_userId` parameter is present for contract symmetry
// but unused here — the tenant guarantee comes from the caller's upstream events
// SELECT, exactly as the YouTube/IG readers document.
//
// published_at drives the tier: a "I logged a promo today for a year-old post"
// paste correctly resolves Cold/Frozen off the POST's published_at, not the
// event's occurred_at.

import { inArray } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import type { AdapterPollState } from "$lib/sources/adapter.js";

export async function telegramFetchPollStateMap(
  _userId: string,
  externalIds: readonly string[],
): Promise<Map<string, AdapterPollState>> {
  const map = new Map<string, AdapterPollState>();
  if (externalIds.length === 0) return map;

  const rows = await db
    .select({
      postId: telegramPosts.postId,
      publishedAt: telegramPosts.publishedAt,
      lastPolledAt: telegramPosts.lastPolledAt,
      lastPollStatus: telegramPosts.lastPollStatus,
    })
    .from(telegramPosts)
    .where(inArray(telegramPosts.postId, [...externalIds]));
  for (const r of rows) {
    map.set(r.postId, {
      publishedAt: r.publishedAt,
      lastPolledAt: r.lastPolledAt,
      lastPollStatus: r.lastPollStatus,
    });
  }
  return map;
}

// Telegram synchronous stats fetch (split out of index.ts; the SyncStatsCapability
// the cross-source createEvent invokes after the events INSERT). Mirrors the
// youtube/reddit module split (sync-path glue beside the barrel).
//
// fetchSyncStats covers the create-WITHOUT-preview path (a direct paste-save that
// never clicked "Fetch") — the preview path already wrote the snapshot, and
// writeTelegramSnapshot's per-minute ON CONFLICT DO NOTHING collapses a
// preview+submit pair to one snapshot row.
//
// #1 — externalId is the rename-proof "<channelKey>/<messageId>". channelKey is
// NOT a fetchable t.me path, so the renameable SLUG is resolved (via the shared
// resolveTelegramFetchTarget) from the stored telegram_posts.external_url (the
// canonical t.me/<slug>/<id> link the preview / resolveCachedExternalId wrote).
// createEvent only calls this with a non-null externalId, and that id only exists
// because resolveCachedExternalId found a cache row → external_url is present. No
// cache row / no resolvable slug → null ("stats unavailable, cron/warm lane will
// pick it up").

import { logger } from "$lib/server/logger.js";
import { fetchTelegramPostSingle } from "./preview.js";
import { resolveTelegramFetchTarget } from "./fetch-target.js";

/**
 * fetchSyncStats — synchronous stats fetch on POST /api/events so /feed shows the
 * view count immediately. Mirrors Reddit's syncStats.fetch: the cross-source
 * createEvent calls this AFTER the events INSERT, errors are logged-and-swallowed
 * by the caller.
 *
 * Telegram is VIEWS-ONLY (no likes/comments on the public t.me surface, D-04), so
 * likeCount/commentCount are constant 0 (the cross-source shape is preserved for
 * UI parity; per-kind feed enrichment reads telegram_post_snapshots for the
 * Telegram-specific view). No authorIsMe signal — a telegram_post has no per-post
 * author to match (author_is_me is inherited from the owned data_sources row at
 * source-create time, D-02). Returns null on fetch failure / unresolvable target
 * → the caller treats it as "stats unavailable, cron/warm lane will pick it up".
 */
export async function fetchSyncStats(
  externalId: string,
  _ctx: { userId: string; ipAddress?: string },
): Promise<{ viewCount: number; likeCount: number; commentCount: number } | null> {
  const target = await resolveTelegramFetchTarget(externalId);
  if (target === null) return null;
  try {
    const post = await fetchTelegramPostSingle(target.slug, target.messageId);
    if (post === null) return null;
    return { viewCount: post.viewCount ?? 0, likeCount: 0, commentCount: 0 };
  } catch (err) {
    logger.warn(
      { externalId, err: String((err as Error)?.message ?? err) },
      "telegram syncStats.fetch failed; UI will rely on cron/warm polling",
    );
    return null;
  }
}

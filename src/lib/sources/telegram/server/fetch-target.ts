// Telegram per-post fetch-target resolver — the ONE place that turns a stored
// channelKey-based post_id back into a fetchable t.me/<slug>/<messageId> target.
//
// The stored post_id / events.external_id is the rename-proof
// "<channelKey>/<messageId>" (the numeric data-view channel id, see parse.ts).
// channelKey is NOT a valid t.me path segment, so to RE-FETCH a known post we
// recover the renameable slug from the cached telegram_posts.external_url (the
// canonical t.me/<slug>/<id> link written on every snapshot). Both the warm-lane
// worker tick and the sync-stats create path need exactly this lookup; it does a
// DB read so it cannot live in the pure url.ts (it uses url.ts splitTelegramPostUrl
// for the string half).
//
// Returns null when the post has no cached row / external_url (it cannot be
// fetched without a known link) → the caller treats it as "stats unavailable,
// cron/warm lane will pick it up".

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { splitTelegramPostUrl } from "./url.js";

export interface TelegramFetchTarget {
  /** Renameable @username — the fetchable t.me path segment. */
  slug: string;
  /** Per-channel sequential message id. */
  messageId: string;
  /** The stored canonical t.me/<slug>/<messageId> URL the target came from. */
  externalUrl: string;
}

/** Resolve the fetchable slug + messageId for a channelKey-based post_id from the
 *  stored telegram_posts.external_url. Returns null when the post has no cache row
 *  / external_url (it can't be fetched without a known link). */
export async function resolveTelegramFetchTarget(
  postId: string,
): Promise<TelegramFetchTarget | null> {
  const [row] = await db
    .select({ externalUrl: telegramPosts.externalUrl })
    .from(telegramPosts)
    .where(eq(telegramPosts.postId, postId))
    .limit(1);
  const externalUrl = row?.externalUrl ?? null;
  if (externalUrl === null) return null;
  const split = splitTelegramPostUrl(externalUrl);
  if (split === null) return null;
  return { slug: split.slug, messageId: split.messageId, externalUrl };
}

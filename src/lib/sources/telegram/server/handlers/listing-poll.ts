// Telegram listing-poll handler — the dual-purpose 6h page-1 fetch (D-04).
//
// Invoked BY the lane worker dispatch (service_source / user_source rows of type
// 'listing_poll'). The lane worker has already acquired a pacer slot via its
// claimGate, so core.pollListing's t.me fetch consumes that politeness budget.
//
// One fetch of t.me/s/<channel> → parse → write a fresh views snapshot per post
// on the newest ~20 posts. This is why a post still on the listing never needs
// the warm lane: the free 6h poll keeps its last_polled_at fresh (the warm
// staleness gate is 12h > 6h). A new post on the listing also gets its first
// snapshot here for free.
//
// not_found (content-based, owned by parse.ts): the channel returned an HTTP-200
// page with no widget markers (renamed/deleted/typo). There is nothing to
// snapshot — log and return. We do NOT write per-post not_found markers from the
// listing path (we have no post ids on a not_found listing; per-post not_found
// is the warm/single-post lane's job when a KNOWN post 404s).
//
// channelKey on the snapshot is left null here — the t.me/s listing markup does
// not carry the intrinsic numeric channel id reliably across post blocks; the
// post_id ("<channel>/<messageId>") already encodes the slug. The post_id is the
// load-bearing key.

import { logger } from "$lib/server/logger.js";
import { telegramChannelAdapterCore } from "../adapter.js";
import { writeTelegramSnapshot } from "../snapshots.js";

const TELEGRAM_BASE = "https://t.me";

/** Build the canonical per-post t.me URL from the "<channel>/<messageId>"
 *  post_id. */
function externalUrlForPost(postId: string): string {
  return `${TELEGRAM_BASE}/${postId}`;
}

export async function handleTelegramListingPoll(args: {
  channel: string;
  userId?: string | null;
  pacer?: "acquire" | "already-acquired";
}): Promise<{ status: "ok" | "not_found"; written: number }> {
  const listing = await telegramChannelAdapterCore.pollListing(
    args.channel,
    null,
    args.pacer ?? "acquire",
  );

  if (listing.status === "not_found") {
    logger.info(
      { channel: args.channel, userId: args.userId ?? null },
      "telegram.listing-poll: channel not found (content-based) — nothing to snapshot",
    );
    return { status: "not_found", written: 0 };
  }

  let written = 0;
  for (const post of listing.posts) {
    await writeTelegramSnapshot({
      postId: post.externalId,
      textSnippet: post.textSnippet,
      mediaKind: post.mediaKind,
      thumbnailUrl: post.thumbnailUrl,
      externalUrl: externalUrlForPost(post.externalId),
      publishedAt: post.publishedAt,
      viewCount: post.viewCount,
      status: "ok",
    });
    written += 1;
  }

  logger.debug(
    { channel: args.channel, written, userId: args.userId ?? null },
    "telegram.listing-poll: page-1 snapshots written",
  );
  return { status: "ok", written };
}

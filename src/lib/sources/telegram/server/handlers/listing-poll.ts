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
// Each post's intrinsic numeric channel id is decoded from its data-view base64
// payload (parse.ts) and threaded onto the snapshot as channel_key — the
// rename-proof group key future per-channel analytics partition by. The channel
// subject entity (telegram_channels) is UPSERTed once per poll from the listing
// header (title / @username slug / avatar / subscriber count / description).

import { logger } from "$lib/server/logger.js";
import { telegramChannelAdapterCore } from "../adapter.js";
import { writeTelegramSnapshot, upsertTelegramChannel } from "../snapshots.js";
import { materializeTelegramEvents } from "../events.js";

const TELEGRAM_BASE = "https://t.me";

/** Build the canonical per-post t.me URL from the renameable slug + messageId.
 *  The stored post_id is channelKey-based (rename-proof), but the channelKey is
 *  NOT a valid t.me path segment — the real link is t.me/<slug>/<messageId>. */
function externalUrlForPost(slug: string, messageId: string): string {
  return `${TELEGRAM_BASE}/${slug}/${messageId}`;
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

  // UPSERT the channel subject entity from the listing header (source-of-truth
  // for the channel's own scraped metadata). No-ops when the header carries no
  // channel id. COALESCE-preserves prior good metadata on a partial parse.
  if (listing.channelHeader !== null) {
    await upsertTelegramChannel(listing.channelHeader);
  }

  let written = 0;
  for (const post of listing.posts) {
    // Skip a post whose channelKey couldn't be decoded → externalId is null. We
    // NEVER snapshot a slug-keyed id (the rename bug); the next poll re-parses
    // the block (the data-view is present on every live block) and writes it.
    if (post.externalId === null) continue;
    await writeTelegramSnapshot({
      postId: post.externalId,
      channelKey: post.channelKey,
      textSnippet: post.textSnippet,
      mediaKind: post.mediaKind,
      thumbnailUrl: post.thumbnailUrl,
      externalUrl: externalUrlForPost(post.slug, post.messageId),
      publishedAt: post.publishedAt,
      viewCount: post.viewCount,
      reactionsTotal: post.reactionsTotal,
      reactionsTop: post.reactionsTop,
      status: "ok",
    });
    written += 1;
  }

  // Materialize feed events from the newest page (source_id set) so steady-state
  // new posts land in /feed + count on /sources — parity with YT/Reddit/IG. The
  // listing-poll owns the STEADY-STATE newest page; the backfill walker owns
  // historical + the initial page. The cron picker (index.ts) skips
  // listing-polling a channel that still has an in-flight backfill_page, so a
  // newly-onboarded channel's newest page is materialized by the walker, not
  // double-fanned here (A2). The fan-out filters per-subscriber by their own
  // backfillTargetSince.
  await materializeTelegramEvents(args.channel, listing.posts, { userId: args.userId });

  logger.debug(
    { channel: args.channel, written, userId: args.userId ?? null },
    "telegram.listing-poll: page-1 snapshots written",
  );
  return { status: "ok", written };
}

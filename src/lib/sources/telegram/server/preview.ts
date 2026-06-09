// Telegram single-post preview + cache-resolve (split out of index.ts, mirrors
// youtube/server/route-metadata.ts + instagram's preview methods living beside
// the barrel).
//
// Holds the shared single-post fetch core (fetchTelegramPostSingle) and the two
// adapter methods that ride on it:
//   - fetchEventPreviewMetadata — the Add Event "Fetch" button (free ?embed=1).
//   - resolveCachedExternalId    — the create-boundary trust gate that re-derives
//     the channelKey-based post id from OUR cache (the body's externalId is
//     untrusted; the URL only carries the renameable slug).
//
// #1 (channelKey-canonical id): the STORED post_id / events.external_id is the
// rename-proof "<channelKey>/<messageId>", NOT "<slug>/<messageId>". The slug is
// the fetchable t.me path segment (channelKey is not), so the fetch uses the
// slug while the WRITE keys on the parsed channelKey. An unresolved channelKey
// (undecodable data-view) → recognition-only with externalId=null — we NEVER
// store a slug-based id (the rename bug). This mirrors Instagram's media-id
// override of the renameable shortcode (instagram/server/normalize.ts:345 +
// instagram/server/index.ts fetchEventPreviewMetadata → externalId, with #69's
// recognition-only → null).

import type { EventPreviewMetadata } from "$lib/sources/adapter.js";
import { eq, desc } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { telegramParsePostUrl } from "./url.js";
import { fetchTelegramPost } from "./http.js";
import { parseTelegramPost, type ParsedTelegramPost } from "./parse.js";
import { writeTelegramSnapshot } from "./snapshots.js";

const TELEGRAM_BASE = "https://t.me";

/** Shared single-post fetch core for the sync paste + preview paths. Issues ONE
 *  ?embed=1 GET through the DEFAULT "acquire" pacer (a sync user path owns its
 *  own slot — the lane worker's "already-acquired" is a worker-only contract),
 *  parses the embed widget, and UPSERTs telegram_posts + a snapshot via
 *  writeTelegramSnapshot so the saved event renders views immediately (mirrors
 *  the warm-lane handleWarmPostFetch + Reddit handlePostSingle / IG
 *  fetchPostByUrl→writeSnapshot).
 *
 *  The fetch uses the renameable SLUG (the fetchable t.me path), but the WRITE
 *  keys the snapshot on the parsed channelKey-based externalId (#1). When the
 *  parsed post has NO channelKey (undecodable data-view) → no slug-keyed write:
 *  we return the parsed post unwritten so the caller degrades to recognition-only
 *  (externalId=null). A null parse → a not_found snapshot keyed on the BEST id we
 *  have only if we have one; with no channelKey there is nothing to key on, so we
 *  skip the marker and return null. AdapterError propagates (the caller maps it
 *  to the graceful-degrade discriminator). */
export async function fetchTelegramPostSingle(
  slug: string,
  messageId: string,
): Promise<ParsedTelegramPost | null> {
  const externalUrl = `${TELEGRAM_BASE}/${slug}/${messageId}`;
  const html = await fetchTelegramPost(slug, messageId);
  const parsed = parseTelegramPost(html);
  if (parsed === null) {
    // Deleted / private / nonexistent — t.me serves HTTP 200 with no widget
    // block. We have no channelKey to key a not_found marker on (the page had no
    // post block at all), so there is nothing to write; the caller degrades.
    return null;
  }
  if (parsed.externalId === null) {
    // The block parsed but its data-view channelKey couldn't be decoded → no
    // canonical key. NEVER write a slug-keyed snapshot (the rename bug); return
    // the parsed post so the caller can still surface title/thumb but degrade the
    // externalId to null (recognition-only, the IG #69 rule).
    return parsed;
  }
  await writeTelegramSnapshot({
    postId: parsed.externalId,
    channelKey: parsed.channelKey,
    textSnippet: parsed.textSnippet,
    mediaKind: parsed.mediaKind,
    thumbnailUrl: parsed.thumbnailUrl,
    externalUrl,
    publishedAt: parsed.publishedAt,
    viewCount: parsed.viewCount,
    status: "ok",
  });
  return parsed;
}

/**
 * fetchEventPreviewMetadata — adapter wrapper for the Add Event "Fetch" button
 * (POST /api/events/preview-url). Mirrors Reddit's / IG's synchronous single-post
 * preview: ONE ?embed=1 t.me GET (free — no credit, no cap), then UPSERTs the
 * telegram_posts cache + a snapshot so the saved event renders views immediately
 * in /feed (exactly like Reddit's preview UPSERTs reddit_posts + a snapshot, and
 * IG's preview UPSERTs instagram_posts + a snapshot).
 *
 * #1 — externalId OVERRIDE: the canonical key is the rename-proof
 * "<channelKey>/<messageId>" decoded from the post's data-view, NOT the
 * URL-parsed "<slug>/<messageId>". So this preview SETS
 * EventPreviewMetadata.externalId to the channelKey-based id (mirrors IG, which
 * overrides the URL shortcode with the media id). events-mutation stores THIS
 * value, not the URL-derived one. When the channelKey can't be resolved
 * (undecodable data-view, deleted/private/unreachable post) → recognition-only
 * with no externalId override; the caller's recognition-only shape stores null
 * (the IG #69 rule — never a slug fallback).
 *
 * Graceful-degrade discriminators (mirrors Reddit's mapping):
 *   - URL not a t.me post  → unreachable(url_not_telegram_post)
 *   - null parse / no channelKey (deleted / private / undecodable) → unavailable
 *   - AdapterError not-found → unavailable
 *   - AdapterError rate-limited (pacer denial / 403 / 429) → unreachable(rate_limited)
 *   - AdapterError transient/permanent (network, 5xx) → unreachable(cause)
 * A typed AppError propagates (none is thrown today; kept for parity with the
 * Reddit branch). Telegram is FREE so there is no cap-exhaustion soft path.
 */
export async function fetchEventPreviewMetadata(
  canonicalUrl: string,
  _ctx: { userId: string; ipAddress: string },
): Promise<EventPreviewMetadata> {
  const parsed = telegramParsePostUrl(canonicalUrl);
  if (parsed === null) {
    return { kind: "unreachable", cause: "url_not_telegram_post" };
  }
  const { channel: slug, messageId } = parsed.metadata as { channel: string; messageId: string };
  try {
    const post = await fetchTelegramPostSingle(slug, messageId);
    // A null post (deleted/private) OR a post whose channelKey couldn't be
    // resolved → unavailable. We will NOT surface a slug-based externalId; the
    // caller's recognition-only path stores null (the IG #69 rule).
    if (post === null || post.externalId === null) return { kind: "unavailable" };
    const snippet = post.textSnippet.trim();
    return {
      kind: "ok",
      // Title = the post's first text line (the user-meaningful label), falling
      // back to "Telegram post <slug>/<id>" so a media-only post still yields a
      // non-empty title (the Add Event form requires one) — mirrors
      // materializeTelegramEvents' title rule. The renameable slug is fine in a
      // human title (it is NOT the stored key).
      title:
        snippet !== "" ? snippet.slice(0, 200) : `Telegram post ${post.slug}/${post.messageId}`,
      // The channel handle is the author surface for a Telegram channel (no
      // per-post author, unlike a subreddit). authorUrl is the canonical channel
      // URL; the display TITLE stays on data_sources (no-denorm — never copied
      // onto the event).
      authorName: post.slug,
      authorUrl: `${TELEGRAM_BASE}/${post.slug}`,
      occurredAt: post.publishedAt ?? undefined,
      thumbnailUrl: post.thumbnailUrl ?? undefined,
      // #1 OVERRIDE — the channelKey-based stable id, NOT the URL slug id. This
      // is what events-mutation stores; the URL-derived value never reaches the
      // events row (mirrors IG's media-id override of the shortcode).
      externalId: post.externalId,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AdapterError) {
      if (err.category === "not-found") return { kind: "unavailable" };
      if (err.category === "rate-limited") return { kind: "unreachable", cause: "rate_limited" };
      return { kind: "unreachable", cause: err.message };
    }
    return { kind: "unreachable", cause: String((err as Error)?.message ?? err) };
  }
}

/**
 * resolveCachedExternalId — re-derive a telegram_post event's channelKey-based
 * post id from OUR cache, given the (canonical) event URL. The single-post
 * PREVIEW (fetchEventPreviewMetadata) UPSERTed telegram_posts with
 * external_url = the canonical t.me/<slug>/<id> URL and post_id = the
 * channelKey-based id, so the create boundary looks the id up by external_url
 * instead of trusting the request body (#70 review P1 — the body is untrusted;
 * a client could pair post A's URL with post B's id) AND instead of the
 * URL-parsed slug id (#1 — the slug is renameable; the stored id is channelKey-
 * based). null when no cache row exists (a create WITHOUT a prior preview, or a
 * preview that couldn't resolve a channelKey) → an honest stats-less card,
 * identical to the recognition-only paste path (NEVER a slug fallback). Mirrors
 * instagram/server/index.ts resolveCachedExternalId.
 */
export async function resolveCachedExternalId(url: string): Promise<string | null> {
  const parsed = telegramParsePostUrl(url);
  if (parsed === null) return null;
  const { channel: slug, messageId } = parsed.metadata as { channel: string; messageId: string };
  // The preview wrote external_url = t.me/<slug>/<messageId> (the canonical link)
  // and post_id = the channelKey-based id. Look up by external_url to recover the
  // stored channelKey-based post_id without trusting the body or the slug id.
  const externalUrl = `${TELEGRAM_BASE}/${slug}/${messageId}`;
  const [row] = await db
    .select({ postId: telegramPosts.postId })
    .from(telegramPosts)
    .where(eq(telegramPosts.externalUrl, externalUrl))
    .orderBy(desc(telegramPosts.updatedAt))
    .limit(1);
  return row?.postId ?? null;
}

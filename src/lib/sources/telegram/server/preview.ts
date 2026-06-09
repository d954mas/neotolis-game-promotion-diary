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
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
import { TELEGRAM_BASE, telegramParsePostUrl, telegramPostUrl } from "./url.js";
import { fetchTelegramPost } from "./http.js";
import { parseTelegramPost, type ParsedTelegramPost } from "./parse.js";
import { writeTelegramSnapshot } from "./snapshots.js";

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
  const externalUrl = telegramPostUrl(slug, messageId);
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
 * post id, given the (canonical) event URL. The single-post PREVIEW
 * (fetchEventPreviewMetadata) UPSERTed telegram_posts with
 * external_url = the canonical t.me/<slug>/<id> URL and post_id = the
 * channelKey-based id, so the create boundary recovers the id WITHOUT trusting
 * the request body (#70 review P1 — the body is untrusted; a client could pair
 * post A's URL with post B's id) AND WITHOUT the URL-parsed slug id (#1 — the
 * slug is renameable; the stored id is channelKey-based).
 *
 * SLUG-REUSE HARDENING (P1-edge): external_url is NOT unique (the PK is the
 * channelKey-based post_id; messageIds are per-channel sequential, NOT globally
 * unique, and a freed @slug can be reassigned to a different channel). So TWO
 * telegram_posts rows can share one external_url with DIFFERENT channelKeys —
 * e.g. channel -100AAA at @durov, then @durov freed + reassigned to -100BBB,
 * both at t.me/durov/505. A recency (ORDER BY updated_at) guess could bind the
 * wrong post. We resolve UNAMBIGUOUSLY by the number of DISTINCT channelKeys
 * (NOT the row count — the collision the header describes is "different
 * channelKeys", and two rows that SHARE a channelKey are the SAME post keyed two
 * ways: a pre-channelKey-canonical slug-keyed row left beside the channelKey-keyed
 * row a later preview wrote. That is benign duplicate keying, not a slug reuse —
 * counting rows there would force a needless live re-fetch that the post-preview
 * pacer slot has just consumed, denying it and falsely degrading to null):
 *   - 0 rows         → null (a create WITHOUT a prior preview, or a preview that
 *                      couldn't resolve a channelKey) → an honest stats-less card,
 *                      identical to the recognition-only paste path (NEVER a slug id).
 *   - 1 channelKey   → the canonical "<channelKey>/<messageId>", built from the
 *                      cached channelKey (unambiguous — the overwhelming common
 *                      case AND the hot post-preview save path: ZERO added t.me
 *                      fetch; rename-proof even if the only cached row is legacy
 *                      slug-keyed).
 *   - 2+ channelKeys → COLLISION: do a live ?embed=1 parse (Telegram is FREE, same
 *                      call fetchEventPreviewMetadata already makes) to decode the
 *                      live channelKey directly — the disambiguating signal the
 *                      external_url cannot carry — and return that exact
 *                      <channelKey>/<messageId>. The live fetch UPSERTs the correct
 *                      row, so it's consistent. A failed fetch / undecodable
 *                      channelKey → null (honest stats-less card; never an
 *                      arbitrary recency guess on a known collision).
 *
 * Mirrors instagram/server/index.ts resolveCachedExternalId (unambiguous-key
 * resolution), and reuses the SAME live-parse path as the preview (#1).
 */
export async function resolveCachedExternalId(url: string): Promise<string | null> {
  const parsed = telegramParsePostUrl(url);
  if (parsed === null) return null;
  const { channel: slug, messageId } = parsed.metadata as { channel: string; messageId: string };
  // The preview wrote external_url = t.me/<slug>/<messageId> (the canonical link)
  // and post_id = the channelKey-based id. Read EVERY cached row's channelKey for
  // that URL — not LIMIT 1 — so a slug-reuse collision (2+ DISTINCT channelKeys)
  // is detectable instead of silently recency-guessed.
  const externalUrl = `${TELEGRAM_BASE}/${slug}/${messageId}`;
  const rows = await db
    .select({ channelKey: telegramPosts.channelKey })
    .from(telegramPosts)
    .where(eq(telegramPosts.externalUrl, externalUrl));

  if (rows.length === 0) return null;
  // Decide on DISTINCT channelKeys, not row count. channelKey is non-null on every
  // row we write (fetchTelegramPostSingle returns unwritten when it's undecodable,
  // so we never persist a slug-keyed snapshot), so the filter only drops
  // hypothetical legacy null rows.
  const channelKeys = new Set(rows.map((r) => r.channelKey).filter((k): k is string => k !== null));
  if (channelKeys.size === 0) return null;
  if (channelKeys.size === 1) {
    // Unambiguous — the canonical channelKey-based id, built from the cached
    // channelKey + the URL messageId (the slug never enters the stored id).
    return `${[...channelKeys][0]}/${messageId}`;
  }

  // COLLISION — a reused slug points one external_url at 2+ posts with different
  // channelKeys. The cache alone cannot disambiguate; resolve from the LIVE
  // page's data-view channelKey (the same free ?embed=1 the preview uses), which
  // is the authoritative answer. fetchTelegramPostSingle UPSERTs the row, so the
  // returned id is both correct and now freshly cached.
  logger.warn(
    { slug, messageId, candidates: channelKeys.size },
    "telegram.resolveCachedExternalId: external_url collision (slug reuse); resolving via live channelKey",
  );
  try {
    const post = await fetchTelegramPostSingle(slug, messageId);
    // No post (deleted/private) OR no decodable channelKey → null (honest
    // stats-less card; never an arbitrary recency guess on a known collision).
    return post?.externalId ?? null;
  } catch (err) {
    // A transient/rate-limited fetch failure on the collision path → null rather
    // than guessing. The user gets a stats-less card; a re-save once t.me is
    // reachable resolves the correct id. (AdapterError is the expected category;
    // an unexpected throw also degrades to null here — this is a best-effort
    // disambiguation on a rare edge, not a hot path that must surface bugs.)
    logger.warn(
      { slug, messageId, err: String((err as Error)?.message ?? err) },
      "telegram.resolveCachedExternalId: live disambiguation fetch failed; returning null",
    );
    return null;
  }
}

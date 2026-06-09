// Telegram URL parsing + canonical-URL string ops — PLAT-06 free-fetch adapter
// input path. PURE module: string ops only, NO I/O, NO DB, NO imports beyond the
// shared ParsedUrl types.
//
// The single home for the t.me/<slug>/<messageId> string shape: TELEGRAM_BASE,
// telegramPostUrl (build), splitTelegramPostUrl (reverse), and the two parsers
// below all share one definition of the host set + slug/messageId regex so the
// canonical-URL shape lives in ONE place instead of being re-derived inline
// across handlers/events/preview/sync-stats/worker-tick.
//
// Two parsers, mirroring the Reddit + Instagram precedents
// (reddit/server/url.ts, instagram/server/url.ts):
//   1. telegramParsePostUrl   — EVENT paste flow. Matches a single message:
//                               `t.me/<slug>/<messageId>` (and the tolerated
//                               `/s/<slug>/<messageId>` preview variant).
//                               Returns a `kind:"telegram_post"` ParsedUrl whose
//                               externalId is the SLUG-based `"<slug>/<messageId>"`.
//                               NOTE: this slug-based id is DELIBERATELY NOT the
//                               stored key — events-mutation excludes telegram_post
//                               from URL-derivation, and the preview /
//                               resolveCachedExternalId resolve the rename-proof
//                               channelKey-based id from our cache (#1). The slug
//                               id here only feeds the cache lookup + fetch path;
//                               it never reaches events.external_id. A channel-only
//                               URL returns null (a channel is a SOURCE, not an
//                               event).
//   2. telegramParseSourceUrl — SOURCE registration flow. Matches a CHANNEL:
//                               `@channel`, bare `channel`, `t.me/<channel>`,
//                               `t.me/s/<channel>`. Returns a
//                               `kind:"telegram_channel"` ParsedSourceUrl. A
//                               post URL returns null (caller meant the post
//                               parser).
//
// Both parsers are pure (no I/O) and HOST-CHECK FIRST so `example.com/durov/505`
// round-trips through `new URL()` but is rejected before pattern-matching —
// leaking a non-Telegram URL into the events table as kind=telegram_post would
// be a data-integrity bug (the same host-first invariant the Reddit/IG parsers
// document).
//
// The channel handle is the URL-intrinsic identity (part of the canonical
// t.me/<handle> URL), NOT a renameable display value — carrying it is the only
// safe denormalization per the AGENTS.md no-denorm carve-out.
//
// Case normalization: the channel SLUG comes out LOWERCASE regardless of input
// casing. Telegram treats `@Durov` and `@durov` as the same channel (handles are
// case-insensitive); lowercasing at parse keeps subscribers who paste
// different-case spellings on the same channel-state row + fan-out lane. Mirrors
// reddit/server/url.ts (subreddit/username lowercase at parse). Message ids are
// case-irrelevant numerics — only the channel segment lowercases.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

/** Canonical t.me base. The single home for the literal — handlers / events /
 *  preview / sync-stats / worker-tick / http all import this instead of
 *  re-declaring `"https://t.me"`. */
export const TELEGRAM_BASE = "https://t.me";

// t.me is canonical; telegram.me / telegram.dog are the official aliases that
// redirect to it. t.me is the load-bearing form.
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

// `/<channel>/<messageId>` and the `/s/<channel>/<messageId>` preview variant.
// Channel handles are `[A-Za-z0-9_]+` (Telegram min 5 chars; permissive regex);
// message ids are digits.
const POST_PATH_RE = /^\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)\/?$/;

// `/<channel>` and the `/s/<channel>` preview variant — channel only, no id.
const SOURCE_PATH_RE = /^\/(?:s\/)?([A-Za-z0-9_]+)\/?$/;

// Raw shapes without a scheme — users commonly paste `@durov` or a bare
// `durov`. `new URL()` rejects these, so they are matched before the URL parse
// attempt. No slash/dot/colon → it is a handle, not a path or URL.
const RAW_HANDLE_RE = /^@?([A-Za-z0-9_]+)$/;

/**
 * Parse a Telegram POST URL into a ParsedUrl event-shape, OR return null for
 * foreign hosts / non-post URLs (including channel-only URLs — a channel is a
 * SOURCE, not an event).
 *
 * Recognized shapes:
 *   - https://t.me/<slug>/<messageId>
 *   - https://t.me/s/<slug>/<messageId>   (tolerated preview variant)
 *   - https://telegram.me|telegram.dog/...   (host aliases)
 *
 * externalId is the SLUG-based `"<slug>/<messageId>"`; metadata carries the slug
 * (as `channel`) + messageId split out for callers that need either part.
 *
 * IMPORTANT: this slug-based externalId is DELIBERATELY NOT stored. The stored
 * events.external_id / telegram_posts.post_id is the rename-proof
 * `"<channelKey>/<messageId>"` (the numeric data-view channel id, see parse.ts).
 * events-mutation excludes telegram_post from URL-derivation; the single-post
 * preview overrides externalId with the channelKey-based id, and
 * resolveCachedExternalId re-derives the stored id from our cache by external_url.
 * The slug id this parser returns only feeds those cache lookups + the fetch
 * path — it never lands in the events row (which would re-key on a rename).
 */
export function telegramParsePostUrl(input: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // Host-check FIRST.
  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;

  const m = POST_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const channel = m[1]!.toLowerCase();
  const messageId = m[2]!;
  return {
    kind: "telegram_post",
    externalId: `${channel}/${messageId}`,
    metadata: { channel, messageId },
  };
}

// Trailing `/<slug>/<messageId>` of a canonical post URL — the reverse of
// telegramPostUrl. Anchored at the end so it pulls the last two segments off any
// t.me/<slug>/<messageId> link (with or without a trailing slash / query is
// already stripped by the callers that store a clean external_url).
const POST_URL_TAIL_RE = /\/([A-Za-z0-9_]+)\/(\d+)\/?$/;

/** Build the canonical per-post t.me URL from the renameable slug + messageId.
 *  The stored post_id is channelKey-based (rename-proof), but the channelKey is
 *  NOT a valid t.me path segment — the real link is t.me/<slug>/<messageId>. The
 *  single home for this builder (handlers / events / preview all import it). */
export function telegramPostUrl(slug: string, messageId: string): string {
  return `${TELEGRAM_BASE}/${slug}/${messageId}`;
}

/** Reverse of telegramPostUrl: split a stored canonical post URL back into its
 *  renameable slug + messageId. Returns null when the URL has no
 *  `/<slug>/<messageId>` tail. The single home for the
 *  fetch-target-resolution regex (worker-tick + sync-stats both used a private
 *  copy). */
export function splitTelegramPostUrl(url: string): { slug: string; messageId: string } | null {
  const m = POST_URL_TAIL_RE.exec(url);
  if (m === null) return null;
  return { slug: m[1]!, messageId: m[2]! };
}

/**
 * Parse a Telegram CHANNEL URL (or a raw `@handle` / bare `handle`) into a
 * ParsedSourceUrl, OR return null for foreign hosts / non-channel shapes.
 *
 * Recognized shapes (all canonicalize to `https://t.me/<handle>`):
 *   - @<handle>                → telegram_channel (raw)
 *   - <handle>                 → telegram_channel (bare)
 *   - https://t.me/<handle>    → telegram_channel
 *   - https://t.me/s/<handle>  → telegram_channel (preview URL)
 *
 * Explicitly rejected:
 *   - Post URLs (`t.me/<ch>/<id>`, `t.me/s/<ch>/<id>`) — caller meant
 *     telegramParsePostUrl. A channel created from a post URL would have a
 *     handle, but the user pasted a POST.
 *   - Foreign hosts (`example.com/durov`) — host-check FIRST.
 */
export function telegramParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // Raw `@handle` / bare `handle` FIRST — no scheme, so `new URL()` would
  // reject them. A slash means it is a path (handled by the URL branch).
  if (!trimmed.includes("/") && !trimmed.includes(".") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!.toLowerCase();
      return {
        kind: "telegram_channel",
        handle,
        externalUrl: `https://t.me/${handle}`,
      };
    }
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Host-check FIRST.
  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Reject post URLs — caller meant telegramParsePostUrl.
  if (POST_PATH_RE.test(url.pathname)) return null;

  const m = SOURCE_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!.toLowerCase();
  return {
    kind: "telegram_channel",
    handle,
    externalUrl: `https://t.me/${handle}`,
  };
}

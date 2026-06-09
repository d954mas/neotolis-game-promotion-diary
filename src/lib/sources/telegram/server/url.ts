// Telegram URL parsing — PLAT-06 free-fetch adapter input path.
//
// Two parsers, mirroring the Reddit + Instagram precedents
// (reddit/server/url.ts, instagram/server/url.ts):
//   1. telegramParsePostUrl   — EVENT paste flow. Matches a single message:
//                               `t.me/<channel>/<messageId>` (and the tolerated
//                               `/s/<channel>/<messageId>` preview variant).
//                               Returns a `kind:"telegram_post"` ParsedUrl whose
//                               externalId is the FULL `"<channel>/<messageId>"`
//                               (RESEARCH Q3: message ids are per-channel
//                               sequential and NOT globally unique, so the
//                               composite is the stable PK — it also matches
//                               telegram_posts.post_id). A channel-only URL
//                               returns null (a channel is a SOURCE, not an
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
// case-insensitive); the channel slug is the key for data_source_channel_state.
// channelKey, telegram_channels.channel, and the `<channel>/<messageId>` post id,
// so lowercasing at parse keeps all of them consistent — two subscribers pasting
// different-case spellings land on the same channel-state row + fan-out lane.
// Mirrors reddit/server/url.ts (subreddit/username lowercase at parse). Message
// ids are case-irrelevant numerics — only the channel segment lowercases.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

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
 *   - https://t.me/<channel>/<messageId>
 *   - https://t.me/s/<channel>/<messageId>   (tolerated preview variant)
 *   - https://telegram.me|telegram.dog/...   (host aliases)
 *
 * externalId is the FULL `"<channel>/<messageId>"`; metadata carries the
 * channel + messageId split out for callers that need either part.
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

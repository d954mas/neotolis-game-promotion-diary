// Twitter/X URL parsing — twitterParseUrl (status permalink) + twitterParseSourceUrl
// (@handle profile).
//
// Two parsers, mirroring the #73-hardened Telegram/TikTok precedents
// (telegram/server/url.ts, tiktok/server/url.ts):
//   1. twitterParseUrl       — EVENT paste flow. Matches a single STATUS permalink:
//                              `x.com/<handle>/status/<id>` (+ twitter.com, mobile.*,
//                              scheme-less). Returns a `kind:"twitter_post"` ParsedUrl
//                              whose externalId is the URL-intrinsic numeric tweet id.
//                              Tracking params (`?s=…`, `?t=…`) are stripped by reading
//                              ONLY the pathname — the query never reaches the id. A
//                              bare profile URL returns null (a profile is a SOURCE).
//   2. twitterParseSourceUrl — SOURCE registration flow. Matches a PROFILE:
//                              `x.com/<handle>` OR the raw `@handle` / bare `handle`.
//                              Returns a `kind:"twitter_account"` ParsedSourceUrl. A
//                              status permalink returns null (caller meant the post
//                              parser).
//
// Both parsers are PURE (no I/O — the registry iterates parseUrl) and HOST-CHECK
// FIRST so `example.com/foo/status/123` round-trips through `new URL()` but is rejected
// before pattern-matching — leaking a non-Twitter URL into the events table as
// kind=twitter_post would be a data-integrity bug (the same host-first invariant the
// Telegram/TikTok parsers document).
//
// Host set: `x.com`, `twitter.com`, `mobile.x.com`, `mobile.twitter.com` (+ `www.`
// variants). NO t.co short-link host (D-07 — NO short-link resolve, YAGNI; X's share
// sheet hands out full x.com URLs, and the canonicalizeOnCreate seam exists if a real
// need ever appears).
//
// UNLIKE TikTok (whose profile path is `/@handle`), Twitter/X profile paths are bare
// `/<handle>` (the @ is NOT part of the path). So a status permalink and a profile URL
// differ only by the `/status/<id>` tail — twitterParseSourceUrl REJECTS the status
// shape before matching the bare-handle path.
//
// The tweet id is the URL-intrinsic identity (part of the canonical /<handle>/status/<id>
// URL), NOT a renameable display value — carrying it is the only safe denormalization
// per the AGENTS.md no-denorm carve-out. The @handle in a status URL is renameable, so
// the post parser keys on the tweet id, not the handle.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

const TWITTER_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

// `/<handle>/status/<id>` — the canonical status permalink. Handles are [A-Za-z0-9_]
// (X usernames); tweet ids are digits. A trailing segment (e.g. `/photo/1`) is
// tolerated so a pasted `…/status/123/photo/1` still resolves the id.
const STATUS_PATH_RE = /^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/[A-Za-z0-9_/]*)?\/?$/;

// `/<handle>` — a bare profile path.
const PROFILE_PATH_RE = /^\/([A-Za-z0-9_]+)\/?$/;

// Raw shapes without a scheme — users commonly paste `@handle` or a bare `handle`.
// `new URL()` rejects these, so they are matched before the URL parse attempt. No
// slash/dot/colon → it is a handle, not a path or URL.
const RAW_HANDLE_RE = /^@?([A-Za-z0-9_]+)$/;

/** Prepend a scheme to a scheme-less input so `new URL()` accepts it. A leading
 *  `//host/...` or bare `host/...` (with a dot in the first segment) is treated as
 *  scheme-less; an already-schemed URL is returned untouched. Mirrors the scheme-less
 *  handling the #73 fix added for handle URLs. */
function withScheme(trimmed: string): string {
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

/** Canonicalize any in-set host to the x.com form (`x.com` is the load-bearing host;
 *  twitter.com / mobile.* are legacy/variant). Keeps the stored externalUrl /
 *  permalink stable regardless of which host the user pasted. */
function canonicalHandleUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

/**
 * Parse a Twitter/X STATUS permalink into a ParsedUrl event-shape, OR return null for
 * foreign hosts / non-status URLs (including bare profile URLs — a profile is a SOURCE,
 * not an event).
 *
 * Recognized shapes:
 *   - https://x.com/<handle>/status/<id>
 *   - https://twitter.com/<handle>/status/<id>
 *   - https://mobile.x.com|mobile.twitter.com/<handle>/status/<id>
 *   - x.com/<handle>/status/<id>            (scheme-less)
 *   - …/status/<id>?s=20  |  …/status/<id>?t=abc   (tracking params stripped — D-07)
 *
 * externalId is the tweet id (the URL-intrinsic, rename-proof numeric status id). The
 * query string is never read, so `?s=…` / `?t=…` are stripped by construction.
 */
export function twitterParseUrl(input: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(withScheme(input.trim()));
  } catch {
    return null;
  }
  // Host-check FIRST.
  if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Read ONLY the pathname — the query (where ?s=/?t= live) is discarded here, so the
  // tracking params are stripped by construction (D-07).
  const m = STATUS_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!;
  const tweetId = m[2]!;
  return {
    kind: "twitter_post",
    externalId: tweetId,
    metadata: {
      handle,
      permalink: `https://x.com/${handle}/status/${tweetId}`,
    },
  };
}

/**
 * Parse a Twitter/X PROFILE URL (or a raw `@handle` / bare `handle`) into a
 * ParsedSourceUrl, OR return null for foreign hosts / non-profile shapes.
 *
 * Recognized shapes (all canonicalize to `https://x.com/<handle>`):
 *   - https://x.com/<handle>            → twitter_account
 *   - https://twitter.com/<handle>      → twitter_account
 *   - https://mobile.x.com/<handle>     → twitter_account
 *   - x.com/<handle>                    → twitter_account (scheme-less, D-07)
 *   - @<handle>                         → twitter_account (raw)
 *   - <handle>                          → twitter_account (bare)
 *
 * Explicitly rejected:
 *   - Status permalinks (`/<handle>/status/<id>`) — caller meant twitterParseUrl.
 *   - Foreign hosts (`example.com/<handle>`) — host-check FIRST.
 */
export function twitterParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // An @-prefixed raw handle FIRST — the leading `@` is unambiguous (a Twitter handle
  // has no dots, so RAW_HANDLE_RE without a dot class is safe). No scheme/slash/colon →
  // not a URL or path.
  if (trimmed.startsWith("@") && !trimmed.includes("/") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!;
      return {
        kind: "twitter_account",
        handle,
        externalUrl: canonicalHandleUrl(handle),
      };
    }
  }

  // Bare `handle` (no @, no scheme, no dot/slash/colon).
  if (!trimmed.includes("/") && !trimmed.includes(".") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!;
      return {
        kind: "twitter_account",
        handle,
        externalUrl: canonicalHandleUrl(handle),
      };
    }
  }

  let url: URL;
  try {
    url = new URL(withScheme(trimmed));
  } catch {
    return null;
  }
  // Host-check FIRST.
  if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Reject status permalinks — caller meant twitterParseUrl.
  if (STATUS_PATH_RE.test(url.pathname)) return null;

  const m = PROFILE_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!;
  return {
    kind: "twitter_account",
    handle,
    externalUrl: canonicalHandleUrl(handle),
  };
}

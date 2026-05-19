// Reddit URL parsing — DV-RDT-7 public-`.json` adapter.
//
// Two parsers:
//   1. redditParsePostUrl   — event paste flow. Matches `/r/<sub>/comments/<id>/<slug?>`
//                             on reddit.com / www.reddit.com / old.reddit.com /
//                             m.reddit.com AND the `redd.it/<id>` short-link form.
//                             Returns null on foreign host (V7 host-check FIRST).
//   2. redditParseSourceUrl — source registration flow. Matches `/r/<sub>` AND
//                             `/user/<handle>` (+ `/u/<handle>` short form) on
//                             the Reddit host family AND the raw `r/X` / `u/X`
//                             prefix shape. Rejects post URLs (caller likely
//                             meant parsePostUrl) and bare names (ambiguous).
//
// Both parsers are pure (no I/O). Both host-check FIRST so
// `example.com/r/X/comments/Y` round-trips through `new URL()` but is
// rejected before pattern-matching — leaking non-Reddit URLs into the
// events table as `kind=reddit_post` would be a data-integrity bug.
//
// Case normalization: subreddit and username identifiers come out
// LOWERCASE regardless of input casing. Reddit treats `r/IndieDev` and
// `r/indiedev` as the same subreddit (and same for usernames); the
// public-data caches (reddit_subreddits_cache.name, reddit_users_cache.
// username, data_sources.metadata.subreddit/username) all key on the
// lowercase form so two subscribers pasting different-case spellings
// land on the same cache row and same fan-out lane. Display-case is
// not preserved — chips render the canonical lowercase.
//
// The cross-source `parseAnyUrl` iterator (src/lib/sources/url.ts) calls
// `redditAdapter.parseUrl` → redditParsePostUrl; the /sources/new
// auto-detect calls `redditAdapter.parseSourceUrl` → redditParseSourceUrl.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com"]);
const SHORT_LINK_HOST = "redd.it";

// `/r/<sub>/comments/<id>/<slug?>` — the canonical post URL on every Reddit
// subdomain. Sub names are `[A-Za-z0-9_-]` (Reddit allows hyphens despite
// the docs); post ids are base36 lowercase alphanumeric.
const POST_URL_RE = /^\/r\/([A-Za-z0-9_-]+)\/comments\/([a-z0-9]+)(?:\/.*)?$/i;
// `/<id>` on redd.it.
const SHORT_LINK_RE = /^\/([a-z0-9]+)$/i;
// `/user/<handle>` and `/u/<handle>` (short form).
const SOURCE_USER_RE = /^\/u(?:ser)?\/([A-Za-z0-9_-]+)\/?$/i;
// `/r/<sub>` (no /comments/ segment).
const SOURCE_SUB_RE = /^\/r\/([A-Za-z0-9_-]+)\/?$/i;
// Raw prefix shapes without scheme — Reddit users commonly paste these.
const RAW_SUB_RE = /^r\/([A-Za-z0-9_-]+)\/?$/i;
const RAW_USER_RE = /^u\/([A-Za-z0-9_-]+)\/?$/i;

/**
 * Parse a Reddit POST URL into a ParsedUrl event-shape, OR return null
 * for non-Reddit hosts / non-post URLs.
 *
 * Recognized shapes:
 *   - https://reddit.com/r/<sub>/comments/<id>/<slug?>
 *   - https://www.reddit.com/r/<sub>/comments/<id>/<slug?>
 *   - https://old.reddit.com/r/<sub>/comments/<id>/<slug?>
 *   - https://m.reddit.com/r/<sub>/comments/<id>/<slug?>
 *   - https://redd.it/<id>
 *
 * Foreign hosts (e.g. `example.com/r/IndieDev/comments/abc`) return null —
 * host-check FIRST avoids leaking non-Reddit URLs into the events table.
 *
 * For redd.it short-links the subreddit is not in the URL — `metadata.subreddit`
 * is null; the worker resolves it via a follow-up fetch on first poll.
 */
export function redditParsePostUrl(input: string): ParsedUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  // redd.it short-link: /<id>
  if (host === SHORT_LINK_HOST) {
    const m = SHORT_LINK_RE.exec(u.pathname);
    if (m === null) return null;
    return {
      kind: "reddit_post",
      externalId: m[1]!,
      metadata: { subreddit: null },
    };
  }

  // Host-check FIRST — V7 invariant.
  if (!REDDIT_HOSTS.has(host)) return null;

  const m = POST_URL_RE.exec(u.pathname);
  if (m === null) return null;
  const subreddit = m[1]!.toLowerCase();
  const externalId = m[2]!;
  return {
    kind: "reddit_post",
    externalId,
    metadata: { subreddit },
  };
}

/**
 * Parse a Reddit SOURCE URL (account or subreddit) into a ParsedSourceUrl,
 * OR return null for foreign hosts / non-source shapes.
 *
 * Recognized shapes (all canonicalize to `https://www.reddit.com/...`):
 *   - https://reddit.com/r/<sub>        → reddit_subreddit
 *   - https://reddit.com/user/<handle>  → reddit_account
 *   - https://reddit.com/u/<handle>     → reddit_account (short form)
 *   - r/<sub>                            → reddit_subreddit (raw prefix)
 *   - u/<handle>                         → reddit_account (raw prefix)
 *
 * Explicitly rejected:
 *   - Post URLs (`/r/X/comments/Y`) — caller likely meant `parsePostUrl`.
 *     Returning a `reddit_subreddit` from a post URL would create a source
 *     whose handle drifts from the post's actual subreddit (the subreddit
 *     name IS in the path, but the user pasted a POST, not a SOURCE).
 *   - Bare names without prefix (`IndieDev`) — ambiguous between sub and
 *     user; force the caller to disambiguate via prefix or full URL.
 *   - Foreign hosts (`example.com/r/X`) — host-check FIRST per V7.
 */
export function redditParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // Raw prefix forms FIRST — these never have a scheme so `new URL()` would
  // reject them; check them before the URL parse attempt.
  const rawSub = RAW_SUB_RE.exec(trimmed);
  if (rawSub !== null) {
    const handle = rawSub[1]!.toLowerCase();
    return {
      kind: "reddit_subreddit",
      handle,
      externalUrl: `https://www.reddit.com/r/${handle}`,
    };
  }
  const rawUser = RAW_USER_RE.exec(trimmed);
  if (rawUser !== null) {
    const handle = rawUser[1]!.toLowerCase();
    return {
      kind: "reddit_account",
      handle,
      externalUrl: `https://www.reddit.com/user/${handle}`,
    };
  }

  // Full URL form.
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!REDDIT_HOSTS.has(host)) return null;

  // Reject post URLs — caller likely meant parsePostUrl, and returning a
  // sub for a post URL is the wrong semantic (the user pasted a post).
  if (POST_URL_RE.test(u.pathname)) return null;

  const userMatch = SOURCE_USER_RE.exec(u.pathname);
  if (userMatch !== null) {
    const handle = userMatch[1]!.toLowerCase();
    return {
      kind: "reddit_account",
      handle,
      externalUrl: `https://www.reddit.com/user/${handle}`,
    };
  }
  const subMatch = SOURCE_SUB_RE.exec(u.pathname);
  if (subMatch !== null) {
    const handle = subMatch[1]!.toLowerCase();
    return {
      kind: "reddit_subreddit",
      handle,
      externalUrl: `https://www.reddit.com/r/${handle}`,
    };
  }

  return null;
}

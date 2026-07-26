// Reddit URL parsing — the carry-over parsers, re-implemented on the Phase-12
// tree (the OLD reddit/server/url.ts was razed wholesale in Plan 12-02; this is
// the same #73-hardened logic, unchanged behavior).
//
// Two parsers:
//   1. redditParsePostUrl   — event paste flow. Matches `/r/<sub>/comments/<id>/<slug?>`
//                             AND `/user/<name>/comments/<id>/<slug?>` on reddit.com /
//                             www / old / m AND the `redd.it/<id>` short-link form.
//                             Returns null on foreign host (host-check FIRST — a
//                             non-Reddit URL can never leak into the events table as
//                             `kind=reddit_post`).
//   2. redditParseSourceUrl — source registration flow. Matches `/r/<sub>` AND
//                             `/user/<handle>` (+ `/u/<handle>` short form) on the
//                             Reddit host family AND the raw `r/X` / `u/X` prefix
//                             shape checked BEFORE `new URL()` (#73 — those raw
//                             forms have no scheme so `new URL()` would reject
//                             them). Rejects post URLs (caller likely meant
//                             parsePostUrl) and bare names (ambiguous).
//
// Both parsers are PURE (no I/O). Both host-check FIRST so
// `example.com/r/X/comments/Y` round-trips through `new URL()` but is rejected
// before pattern-matching (T-12-03-T mitigation).
//
// Case normalization: subreddit + username identifiers come out LOWERCASE
// regardless of input casing. Reddit treats `r/IndieDev` and `r/indiedev` as the
// same subreddit (same for usernames); the intrinsic slug is the safe
// denormalization (AGENTS.md), and lowercasing keeps two subscribers pasting
// different-case spellings on the same cache row + fan-out lane.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com"]);
const SHORT_LINK_HOST = "redd.it";

// `/r/<sub>/comments/<id>/<slug?>` — the canonical post URL on every Reddit
// subdomain. Sub names are `[A-Za-z0-9_-]` (Reddit allows hyphens despite the
// docs); post ids are base36 lowercase alphanumeric. `/user/<u>/comments/<id>`
// is the profile-self-post variant — accept both `/r/` and `/user/` roots, and
// CAPTURE the root so the two can never be conflated (see PROFILE_SUB_PREFIX).
const POST_URL_RE = /^\/(r|user)\/([A-Za-z0-9_-]+)\/comments\/([a-z0-9]+)(?:\/.*)?$/i;
/** Reddit's pseudo-subreddit for a profile ("u/foo" posts live in "u_foo"). A
 *  `/user/<name>/comments/<id>` URL therefore resolves its feed under `u_<name>`,
 *  NOT `<name>`: the provider's subreddit endpoint keys on the SUBREDDIT slug, and
 *  `?subreddit=<name>` either 404s or — worse — returns the unrelated r/<name>
 *  community's posts (spike fixture: u/d954mas' posts carry `subreddit: "u_d954mas"`).
 *  The same prefixed value is what the walker caches as reddit_posts.subreddit_slug,
 *  so preview + walk + refresh all agree on one identity for a profile post. */
const PROFILE_SUB_PREFIX = "u_";
// `/<id>` on redd.it.
const SHORT_LINK_RE = /^\/([a-z0-9]+)$/i;
// `/comments/<id>` — Reddit's own subreddit-less canonical form (it redirects to the
// full permalink). Three places produce it: the walker's fallback URL when a page
// carried no permalink, the deletion-propagation purge (which strips `/user/<name>/`
// out of a deleted post's URL — deletion-propagation-cron.ts), and users pasting the
// share-menu link. It MUST parse: `validateEventInput` rejects any reddit_post whose
// url does not parse, so an un-parsed form would 422 every later PATCH of that event.
// Recognition-only, like redd.it — the subreddit is absent, so no feed can be searched.
const BARE_COMMENTS_RE = /^\/comments\/([a-z0-9]+)(?:\/.*)?$/i;
// `/user/<handle>` and `/u/<handle>` (short form).
const SOURCE_USER_RE = /^\/u(?:ser)?\/([A-Za-z0-9_-]+)\/?$/i;
// `/r/<sub>` (no /comments/ segment).
const SOURCE_SUB_RE = /^\/r\/([A-Za-z0-9_-]+)\/?$/i;
// Raw prefix shapes without scheme — Reddit users commonly paste these.
const RAW_SUB_RE = /^r\/([A-Za-z0-9_-]+)\/?$/i;
const RAW_USER_RE = /^u\/([A-Za-z0-9_-]+)\/?$/i;

/**
 * Parse a Reddit POST URL into a ParsedUrl event-shape, OR return null for
 * non-Reddit hosts / non-post URLs.
 *
 * Recognized shapes:
 *   - https://{reddit.com|www|old|m}/r/<sub>/comments/<id>/<slug?>
 *   - https://{...}/user/<u>/comments/<id>/<slug?>   (profile self-post → `u_<u>`)
 *   - https://{...}/comments/<id>                    (RECOGNITION-ONLY, see below)
 *   - https://redd.it/<id>                           (RECOGNITION-ONLY, see below)
 *
 * Foreign hosts (e.g. `example.com/r/IndieDev/comments/abc`) return null —
 * host-check FIRST avoids leaking non-Reddit URLs into the events table.
 *
 * `metadata.subreddit` is the feed identity the provider needs. It is null for the two
 * SUBREDDIT-LESS forms (`redd.it/<id>` and `/comments/<id>`): ScrapeCreators exposes no
 * lookup-by-id and no redirect follower, so there is no feed to search. A null slug
 * means RECOGNITION-ONLY — the event saves fine as `kind=reddit_post`, but the preview
 * says so explicitly (index.ts `reddit_short_link_unsupported`) instead of burning a
 * cap slot on a request that can never succeed.
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

  // Host-check FIRST.
  if (!REDDIT_HOSTS.has(host)) return null;

  const bare = BARE_COMMENTS_RE.exec(u.pathname);
  if (bare !== null) {
    return {
      kind: "reddit_post",
      externalId: bare[1]!,
      metadata: { subreddit: null },
    };
  }

  const m = POST_URL_RE.exec(u.pathname);
  if (m === null) return null;
  const isProfilePost = m[1]!.toLowerCase() === "user";
  const name = m[2]!.toLowerCase();
  const externalId = m[3]!;
  return {
    kind: "reddit_post",
    externalId,
    metadata: { subreddit: isProfilePost ? `${PROFILE_SUB_PREFIX}${name}` : name },
  };
}

/**
 * Parse a Reddit SOURCE URL (account or subreddit) into a ParsedSourceUrl, OR
 * return null for foreign hosts / non-source shapes.
 *
 * Recognized shapes (all canonicalize to `https://www.reddit.com/...`):
 *   - https://reddit.com/r/<sub>        → reddit_subreddit
 *   - https://reddit.com/user/<handle>  → reddit_account
 *   - https://reddit.com/u/<handle>     → reddit_account (short form)
 *   - r/<sub>                            → reddit_subreddit (raw prefix)
 *   - u/<handle>                         → reddit_account (raw prefix)
 *
 * Explicitly rejected: post URLs (`/r/X/comments/Y` — caller meant parsePostUrl),
 * bare names without prefix (ambiguous sub-vs-user), foreign hosts (host-check
 * FIRST).
 */
export function redditParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // Raw prefix forms FIRST — these never have a scheme so `new URL()` would
  // reject them; check them before the URL parse attempt (#73).
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

  // Reject post URLs — caller likely meant parsePostUrl, and returning a sub for
  // a post URL is the wrong semantic (the user pasted a post, not a source).
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

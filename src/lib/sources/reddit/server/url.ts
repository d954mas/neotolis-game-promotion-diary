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
// The title SLUG (first segment after the id, before any comment-permalink tail)
// is CAPTURED too: the ScrapeCreators detail endpoint returns a DEGRADED post
// object (created_utc/author null) for slug-less URLs, so the canonical URL must
// preserve the slug when the paste carried one (12-06 UAT).
const POST_URL_RE = /^\/(r|user)\/([A-Za-z0-9_-]+)\/comments\/([a-z0-9]+)(?:\/([^/]*)(?:\/.*)?)?$/i;
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
// Exact-detail accepts this form even though no source-walk identity is present.
const BARE_COMMENTS_RE = /^\/comments\/([a-z0-9]+)(?:\/.*)?$/i;

/** `redd.it/<id>` is recognition-only until its redirect behavior is verified.
 * Reddit's own `/comments/<id>` canonical URL is not a short link: the exact-detail
 * endpoint accepts it directly, including after the GDPR purge removes a profile
 * username from the original permalink. */
export function redditIsShortPostUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  return url.hostname.toLowerCase() === SHORT_LINK_HOST && SHORT_LINK_RE.test(url.pathname);
}
// `/r|u|user/<name>/s/<token>` — the mobile-app SHARE link. The token is an
// OPAQUE case-sensitive redirect key, NOT the post id, so this form cannot
// yield a ParsedUrl (no externalId exists until the redirect resolves) — it
// parses through redditParseShareUrl into a recognition shape, and the preview
// path resolves the identity via the provider's detail endpoint, which follows
// the share redirect server-side (12-06 UAT probe: /r/itchio/s/… resolved).
const SHARE_URL_RE = /^\/(r|u|user)\/([A-Za-z0-9_-]+)\/s\/([A-Za-z0-9]+)\/?$/i;
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
 *   - https://{...}/comments/<id>                    (exact-detail capable)
 *   - https://redd.it/<id>                           (RECOGNITION-ONLY, see below)
 *
 * Foreign hosts (e.g. `example.com/r/IndieDev/comments/abc`) return null —
 * host-check FIRST avoids leaking non-Reddit URLs into the events table.
 *
 * `metadata.subreddit` is the feed identity used by source walks. It is null for the
 * two SUBREDDIT-LESS forms (`redd.it/<id>` and `/comments/<id>`), but only `redd.it`
 * remains recognition-only. The exact-detail endpoint accepts Reddit's canonical
 * `/comments/<id>` URL directly.
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
  // URL-intrinsic title slug (safe to carry — part of the canonical URL). null
  // when the paste had none; the canonicalizer then builds the slug-less form.
  const slug = m[4] !== undefined && m[4] !== "" ? m[4] : null;
  return {
    kind: "reddit_post",
    externalId,
    metadata: { subreddit: isProfilePost ? `${PROFILE_SUB_PREFIX}${name}` : name, slug },
  };
}

export interface RedditShareLink {
  /** Feed-identity hint from the URL path (`u_<name>` for profile roots) — lowercase. */
  subreddit: string;
  /** Normalized `https://www.reddit.com` share URL, query/hash stripped. The token's
   *  case is PRESERVED (it is a case-sensitive redirect key), and the root segment
   *  keeps the pasted spelling (`u` vs `user`) — the URL is handed VERBATIM to
   *  Reddit via the provider, and only the pasted spelling is known to resolve. */
  canonicalUrl: string;
}

/**
 * Parse a Reddit `/s/` SHARE link (`/r/<sub>/s/<token>`, `/u|user/<name>/s/<token>`)
 * into a recognition shape, OR return null for foreign hosts / non-share URLs.
 * Distinct from redditParsePostUrl because the share token is NOT the post id —
 * there is no externalId to return; the provider's detail endpoint resolves the
 * redirect server-side and the preview rewrites the canonical URL from the result.
 */
export function redditParseShareUrl(input: string): RedditShareLink | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  // Host-check FIRST (same T-12-03-T rule as the post parser).
  if (!REDDIT_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = SHARE_URL_RE.exec(u.pathname);
  if (m === null) return null;
  const root = m[1]!.toLowerCase();
  const name = m[2]!;
  const token = m[3]!;
  return {
    subreddit: root === "r" ? name.toLowerCase() : `${PROFILE_SUB_PREFIX}${name.toLowerCase()}`,
    canonicalUrl: `https://www.reddit.com/${root}/${name}/s/${token}`,
  };
}

/** Reddit-style title slug for a REBUILT permalink. Reddit resolves ANY slug for a
 *  given post id, but the ScrapeCreators detail endpoint returns a DEGRADED post
 *  for SLUG-LESS URLs (12-06 UAT), so a non-empty slug is load-bearing — "post" is
 *  the guaranteed-non-empty fallback for unsluggable (e.g. all-emoji) titles. */
export function redditTitleSlug(title: string | null): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50)
    .replace(/_+$/, "");
  return slug === "" ? "post" : slug;
}

/** Rebuild the canonical slugged permalink from RESOLVED post parts — the /s/
 *  share-link path, where the pasted URL carries no post id and the detail
 *  response carries no permalink field. `subredditSlug` uses the walker's
 *  `u_<name>` convention for profile posts (maps back to `/user/<name>/`). */
export function redditBuildPermalink(
  subredditSlug: string,
  shortId: string,
  title: string | null,
): string {
  const root = subredditSlug.startsWith(PROFILE_SUB_PREFIX)
    ? `user/${subredditSlug.slice(PROFILE_SUB_PREFIX.length)}`
    : `r/${subredditSlug}`;
  return `https://www.reddit.com/${root}/comments/${shortId}/${redditTitleSlug(title)}/`;
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

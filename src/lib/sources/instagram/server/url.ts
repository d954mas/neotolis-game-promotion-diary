// Instagram URL parsing — SOC-01 input path.
//
// Two parsers, mirroring the Reddit precedent (reddit/server/url.ts):
//   1. instagramParseUrl       — EVENT paste flow. Matches a single
//                                post/reel PERMALINK: `/p/<code>`,
//                                `/reel/<code>`, `/reels/<code>`. Returns a
//                                `kind:"instagram_post"` ParsedUrl carrying
//                                the shortcode (08-SPIKE `code`) as
//                                externalId. A bare profile URL returns null
//                                (a profile is a SOURCE, not an event).
//   2. instagramParseSourceUrl — SOURCE registration flow. Matches a
//                                PROFILE/handle: `/<handle>` (one
//                                non-reserved segment) OR the raw `@handle`
//                                / `handle` shape. Returns a
//                                `kind:"instagram_account"` ParsedSourceUrl.
//                                A permalink returns null (caller meant the
//                                post parser).
//
// Both parsers are pure (no I/O) and HOST-CHECK FIRST so
// `example.com/p/XYZ` round-trips through `new URL()` but is rejected
// before pattern-matching — leaking a non-Instagram URL into the events
// table as kind=instagram_post would be a data-integrity bug (the same V7
// host-first invariant the Reddit parser documents).
//
// The shortcode (`code`) is the URL-intrinsic identity used to build the
// permalink (`instagram.com/p/<code>/` or `/reel/<code>/`, 08-SPIKE) — it
// is NOT a renameable display value, so carrying it is safe per the
// AGENTS.md no-denorm rule (an intrinsic URL-identity slug, the only safe
// denormalization).
//
// Plan 05's adapter `parseUrl` / `parseSourceUrl` delegate to these; Plan
// 05 registers the IG adapter in registry.ts so the cross-source
// `parseAnyUrl` first-match-wins router (src/lib/sources/url.ts) and the
// /sources/new auto-detect pick them up.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);

// First-segment paths that are Instagram app routes, NOT user handles.
// A profile URL is `/<handle>/`; these reserved roots must NOT be parsed as
// a handle by instagramParseSourceUrl.
const RESERVED_FIRST_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "explore",
  "stories",
  "accounts",
  "direct",
  "tv",
  "about",
  "developer",
  "legal",
  "directory",
]);

// `/p/<code>`, `/reel/<code>`, `/reels/<code>` — the canonical single-media
// permalink. Shortcodes are URL-safe base64-ish: [A-Za-z0-9_-].
const PERMALINK_RE = /^\/(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/;

// A bare profile path: exactly one segment, the handle. Handles are
// [A-Za-z0-9._] (Instagram allows dots and underscores).
const PROFILE_PATH_RE = /^\/([A-Za-z0-9._]+)\/?$/;

// Raw prefix shapes without a scheme — users commonly paste `@handle` or a
// bare `handle`. `new URL()` rejects these, so they are matched before the
// URL parse attempt.
const RAW_HANDLE_RE = /^@?([A-Za-z0-9._]+)$/;

/**
 * Parse an Instagram POST/REEL permalink into a ParsedUrl event-shape, OR
 * return null for foreign hosts / non-permalink URLs (including bare
 * profile URLs — a profile is a SOURCE, not an event).
 *
 * Recognized shapes:
 *   - https://www.instagram.com/p/<code>/
 *   - https://instagram.com/reel/<code>/
 *   - https://instagram.com/reels/<code>/
 *
 * The permalink in `metadata.permalink` is the canonicalized `/p/` or
 * `/reel/` URL (path-only, query stripped) — Instagram's own canonical form.
 */
export function instagramParseUrl(input: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) return null;

  const m = PERMALINK_RE.exec(url.pathname);
  if (m === null) return null;
  const segment = m[1]!;
  const code = m[2]!;
  // `/reels/<code>` is the plural app route; canonicalize to the singular
  // `/reel/<code>/` form Instagram shares. `/p/` stays `/p/`.
  const canonicalSegment = segment === "p" ? "p" : "reel";
  const permalink = `https://www.instagram.com/${canonicalSegment}/${code}/`;
  return {
    kind: "instagram_post",
    externalId: code,
    metadata: { permalink },
  };
}

/**
 * Parse an Instagram PROFILE URL (or a raw `@handle` / `handle`) into a
 * ParsedSourceUrl, OR return null for foreign hosts / non-profile shapes.
 *
 * Recognized shapes (all canonicalize to `https://www.instagram.com/<handle>/`):
 *   - https://www.instagram.com/<handle>/   → instagram_account
 *   - https://instagram.com/<handle>        → instagram_account
 *   - @<handle>                              → instagram_account (raw)
 *   - <handle>                               → instagram_account (raw)
 *
 * Explicitly rejected:
 *   - Permalinks (`/p/`, `/reel/`, `/reels/`) — caller meant
 *     `instagramParseUrl`. A profile created from a permalink would have a
 *     handle drifting from the post.
 *   - Reserved app routes (`/explore`, `/stories`, `/accounts`, …) — these
 *     are not user handles.
 *   - Foreign hosts (`example.com/natgeo`) — host-check FIRST.
 */
export function instagramParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // An @-prefixed raw handle FIRST — the leading `@` is unambiguous (an Instagram
  // profile URL is `instagram.com/<handle>`, never a bare `@handle` URL), so a
  // DOTTED @handle (e.g. `@some.handle` — RAW_HANDLE_RE allows dots) is safely a
  // handle, not a hostname. No scheme/slash/colon → not a URL or path.
  if (trimmed.startsWith("@") && !trimmed.includes("/") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!;
      return {
        kind: "instagram_account",
        handle,
        externalUrl: `https://www.instagram.com/${handle}/`,
      };
    }
  }

  // Bare `handle` (no @, no scheme) — DOT-GATED: a bare dotted string (`some.handle`)
  // is hostname-ambiguous (could be a domain), so it falls through to the URL branch
  // below. Only a dotless bare handle (`natgeo`) resolves here.
  if (!trimmed.includes("/") && !trimmed.includes(".") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!;
      return {
        kind: "instagram_account",
        handle,
        externalUrl: `https://www.instagram.com/${handle}/`,
      };
    }
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) return null;

  // Reject permalinks — caller meant the post parser.
  if (PERMALINK_RE.test(url.pathname)) return null;

  const m = PROFILE_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!;
  if (RESERVED_FIRST_SEGMENTS.has(handle.toLowerCase())) return null;

  return {
    kind: "instagram_account",
    handle,
    externalUrl: `https://www.instagram.com/${handle}/`,
  };
}

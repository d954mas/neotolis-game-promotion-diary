// TikTok URL parsing — parseUrl (video permalink) + parseSourceUrl (@handle).
//
// Two parsers, mirroring the #73-hardened Telegram/Instagram precedents
// (telegram/server/url.ts, instagram/server/url.ts):
//   1. tiktokParseUrl       — EVENT paste flow. Matches a single video
//                             PERMALINK: `tiktok.com/@<handle>/video/<id>`.
//                             Returns a `kind:"tiktok_post"` ParsedUrl carrying
//                             the aweme id as externalId. A bare profile URL
//                             returns null (a profile is a SOURCE, not an event).
//   2. tiktokParseSourceUrl — SOURCE registration flow. Matches a PROFILE:
//                             `tiktok.com/@<handle>` OR the raw `@handle` /
//                             bare `handle` shape. Returns a
//                             `kind:"tiktok_account"` ParsedSourceUrl. A video
//                             permalink returns null (caller meant the post
//                             parser).
//
// Both parsers are PURE (no I/O — the registry iterates parseUrl) and HOST-CHECK
// FIRST so `example.com/@user/video/123` round-trips through `new URL()` but is
// rejected before pattern-matching — leaking a non-TikTok URL into the events
// table as kind=tiktok_post would be a data-integrity bug (the same host-first
// invariant the Telegram/Reddit/IG parsers document).
//
// Host set: `tiktok.com`, `www.tiktok.com` ONLY. The short-link hosts
// (`vm.tiktok.com` / `vt.tiktok.com`) are NOT here — they resolve to a canonical
// tiktok.com URL via short-link.ts (D-06) FIRST, then re-parse through these.
//
// The aweme id is the URL-intrinsic identity (part of the canonical
// /@handle/video/<id> URL), NOT a renameable display value — carrying it is the
// only safe denormalization per the AGENTS.md no-denorm carve-out. The @handle
// in a video URL is renameable, so the post parser keys on the aweme id, not the
// handle.

import type { ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";

// Canonical hosts. vm./vt. are DELIBERATELY excluded — they go through
// short-link.ts first (D-06).
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com"]);

// `/@<handle>/video/<id>` — the canonical single-video permalink. Handles are
// [A-Za-z0-9._]; aweme ids are digits.
const VIDEO_PATH_RE = /^\/@([A-Za-z0-9._]+)\/video\/(\d+)\/?$/;

// `/@<handle>` — a bare profile path (the @ is part of the path on TikTok).
const PROFILE_PATH_RE = /^\/@([A-Za-z0-9._]+)\/?$/;

// Raw shapes without a scheme — users commonly paste `@handle` or a bare
// `handle`. `new URL()` rejects these, so they are matched before the URL parse
// attempt. No slash/dot/colon → it is a handle, not a path or URL.
const RAW_HANDLE_RE = /^@?([A-Za-z0-9._]+)$/;

/** Prepend a scheme to a scheme-less input so `new URL()` accepts it. A leading
 *  `//host/...` or bare `host/...` (with a dot in the first segment) is treated
 *  as scheme-less; an already-schemed URL is returned untouched. Mirrors the
 *  scheme-less handling the #73 fix added for handle URLs. */
function withScheme(trimmed: string): string {
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

/**
 * Parse a TikTok VIDEO permalink into a ParsedUrl event-shape, OR return null
 * for foreign hosts / non-video URLs (including bare profile URLs — a profile is
 * a SOURCE, not an event) and short-link hosts (those resolve via short-link.ts
 * first).
 *
 * Recognized shapes:
 *   - https://www.tiktok.com/@<handle>/video/<id>
 *   - https://tiktok.com/@<handle>/video/<id>
 *   - www.tiktok.com/@<handle>/video/<id>   (scheme-less)
 *
 * externalId is the aweme id (the URL-intrinsic, rename-proof video id).
 */
export function tiktokParseUrl(input: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(withScheme(input.trim()));
  } catch {
    return null;
  }
  // Host-check FIRST. vm./vt. short links are NOT here — they go through
  // short-link.ts first.
  if (!TIKTOK_HOSTS.has(url.hostname.toLowerCase())) return null;

  const m = VIDEO_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!;
  const awemeId = m[2]!;
  return {
    kind: "tiktok_post",
    externalId: awemeId,
    metadata: {
      handle,
      permalink: `https://www.tiktok.com/@${handle}/video/${awemeId}`,
    },
  };
}

/**
 * Parse a TikTok PROFILE URL (or a raw `@handle` / bare `handle`) into a
 * ParsedSourceUrl, OR return null for foreign hosts / non-profile shapes.
 *
 * Recognized shapes (all canonicalize to `https://www.tiktok.com/@<handle>`):
 *   - https://www.tiktok.com/@<handle>   → tiktok_account
 *   - https://tiktok.com/@<handle>       → tiktok_account (bare host)
 *   - tiktok.com/@<handle>               → tiktok_account (scheme-less, D-05)
 *   - @<handle>                          → tiktok_account (raw)
 *   - <handle>                           → tiktok_account (bare)
 *
 * Explicitly rejected:
 *   - Video permalinks (`/@<handle>/video/<id>`) — caller meant tiktokParseUrl.
 *   - Foreign hosts (`example.com/@user`) — host-check FIRST.
 */
export function tiktokParseSourceUrl(input: string): ParsedSourceUrl | null {
  const trimmed = input.trim();

  // Raw `@handle` / bare `handle` FIRST — no scheme, so `new URL()` would reject
  // them. A slash/dot/colon means it is a path or URL (handled by the URL branch).
  if (!trimmed.includes("/") && !trimmed.includes(".") && !trimmed.includes(":")) {
    const raw = RAW_HANDLE_RE.exec(trimmed);
    if (raw !== null) {
      const handle = raw[1]!;
      return {
        kind: "tiktok_account",
        handle,
        externalUrl: `https://www.tiktok.com/@${handle}`,
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
  if (!TIKTOK_HOSTS.has(url.hostname.toLowerCase())) return null;

  // Reject video permalinks — caller meant tiktokParseUrl.
  if (VIDEO_PATH_RE.test(url.pathname)) return null;

  const m = PROFILE_PATH_RE.exec(url.pathname);
  if (m === null) return null;
  const handle = m[1]!;
  return {
    kind: "tiktok_account",
    handle,
    externalUrl: `https://www.tiktok.com/@${handle}`,
  };
}

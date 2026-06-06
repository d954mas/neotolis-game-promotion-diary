// Client-side source-kind inference from a pasted Handle URL.
//
// The authoritative URL parsers (instagramParseSourceUrl,
// redditParseSourceUrl, …) live in SERVER modules
// (src/lib/sources/*/server/url.ts) and cannot be imported into the
// client bundle (they pull in the adapter / DB types). This is a small
// PURE, client-safe hostname heuristic — "paste a link → we figure out
// the kind" — that lets the Add-Source surfaces auto-select the matching
// chip (or surface the right disabled hint) the moment the user pastes.
//
// It returns the UI-level SourceKind the chip picker uses, NOT the DB
// SourceKind: "reddit" is the synthetic single picker entry that the
// server later resolves to reddit_account vs reddit_subreddit by URL
// shape (see /sources/new/+page.server.ts). The server's
// allAdapters[*].parseSourceUrl iterator remains the source of truth on
// submit; this heuristic is a UX convenience, never a validation gate.

// UI-level chip kinds — mirrors the SourceKind union in the two
// Add-Source surfaces. Kept as a string union (not the DB SourceKind) so
// the helper can name the synthetic "reddit" picker entry.
export type InferredSourceKind =
  | "youtube_channel"
  | "reddit"
  | "instagram_account"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server";

// Host suffix → chip kind. Order doesn't matter — each suffix is
// disjoint. We match on the URL hostname (suffix match so subdomains
// like m.youtube.com / old.reddit.com resolve correctly), with a
// substring fallback for bare/raw inputs (e.g. "youtu.be/…" pasted
// without a scheme) so the heuristic mirrors the existing lightweight
// `handleUrl.toLowerCase().includes("instagram")` hint logic.
const HOST_SUFFIX_TO_KIND: ReadonlyArray<readonly [string, InferredSourceKind]> = [
  ["youtube.com", "youtube_channel"],
  ["youtu.be", "youtube_channel"],
  ["reddit.com", "reddit"],
  ["redd.it", "reddit"],
  ["instagram.com", "instagram_account"],
  ["twitter.com", "twitter_account"],
  ["x.com", "twitter_account"],
  ["t.me", "telegram_channel"],
  ["telegram.me", "telegram_channel"],
  ["telegram.org", "telegram_channel"],
  ["discord.gg", "discord_server"],
  ["discord.com", "discord_server"],
];

function hostnameOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchHostSuffix(hostname: string): InferredSourceKind | null {
  for (const [suffix, kind] of HOST_SUFFIX_TO_KIND) {
    // Exact host OR a subdomain of it (".reddit.com" rules out
    // "notreddit.com" while still matching "old.reddit.com").
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return kind;
    }
  }
  return null;
}

function matchSubstring(lowered: string): InferredSourceKind | null {
  for (const [suffix, kind] of HOST_SUFFIX_TO_KIND) {
    if (lowered.includes(suffix)) return kind;
  }
  return null;
}

/**
 * Map a pasted Handle URL to its candidate UI SourceKind by hostname.
 *
 * Returns the synthetic UI kind the chip picker uses ("reddit" rather
 * than reddit_account / reddit_subreddit). Returns null for unknown or
 * garbage input — the caller leaves the current selection untouched.
 *
 * Prefers a structured hostname suffix match; falls back to a substring
 * scan for scheme-less / raw input so a paste of "youtu.be/abc" still
 * resolves the chip before the URL is fully typed.
 */
export function inferSourceKindFromUrl(input: string): InferredSourceKind | null {
  if (input.trim().length === 0) return null;
  const hostname = hostnameOf(input);
  if (hostname !== null) {
    const byHost = matchHostSuffix(hostname);
    if (byHost !== null) return byHost;
  }
  return matchSubstring(input.toLowerCase());
}

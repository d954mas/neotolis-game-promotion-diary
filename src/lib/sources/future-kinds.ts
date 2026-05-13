// Future-kinds host hint.
//
// URL detection is delegated to per-adapter parseUrl(url) via the registry
// (first-match-wins iteration). When no adapter matches (e.g. reddit.com
// has no Reddit adapter wired yet), parseAnyUrl returns
// { kind: "unsupported" } and the UI would lose context that we recognised
// the host but can't yet ingest from it.
//
// services/ingest.ts uses this map AFTER parseAnyUrl returns
// unsupported to surface a friendly inline-info AppError(422,
// 'reddit_not_yet_supported') for hosts on the curated future-kinds list.
// Map entries shrink as adapters land.
import type { EventKind } from "./adapter.js";

const FUTURE_KIND_HOSTS = new Map<string, EventKind>([
  ["reddit.com", "reddit_post"],
  ["www.reddit.com", "reddit_post"],
  ["old.reddit.com", "reddit_post"],
  ["redd.it", "reddit_post"],
]);

export function detectFutureKind(input: string): EventKind | null {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase();
    return FUTURE_KIND_HOSTS.get(host) ?? null;
  } catch {
    return null;
  }
}

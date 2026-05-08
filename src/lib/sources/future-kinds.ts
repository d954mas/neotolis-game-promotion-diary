// Future-kinds host hint — Phase 03.0.1 RESEARCH.md § "Pattern 3 SOTA divergence callout".
//
// After Plan 06 moves URL detection into per-adapter parseUrl(url) (D-15
// first-match-wins iteration), no Reddit adapter exists yet → parseAnyUrl
// would return { kind: "unsupported" } for reddit.com URLs and the UI
// would lose the friendly "Reddit ingest arrives in Phase 3" message.
//
// services/ingest.ts uses this map AFTER parseAnyUrl returns
// unsupported to surface a friendly inline-info AppError(422,
// 'reddit_pending_phase3') for hosts on the curated future-kinds list.
// Map entries shrink as adapters land (Phase 03.1 removes the reddit_post entry).
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

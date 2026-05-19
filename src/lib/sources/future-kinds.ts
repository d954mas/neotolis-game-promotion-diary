// Future-kinds host hint.
//
// URL detection is delegated to per-adapter parseUrl(url) via the registry
// (first-match-wins iteration). When no adapter matches the host (e.g.
// the host belongs to a deferred platform like Twitter / Telegram /
// Discord), parseAnyUrl returns { kind: "unsupported" } and the UI would
// lose context that we recognised the host but can't yet ingest from it.
//
// services/ingest.ts uses this map AFTER parseAnyUrl returns
// unsupported to surface a friendly inline-info AppError (e.g.
// 'twitter_not_yet_supported') for hosts on the curated future-kinds
// list. Map entries shrink as adapters land.
//
// Phase 03.1 (D-RDT-INGEST-REPLACE): reddit.com / www.reddit.com /
// old.reddit.com / redd.it entries REMOVED — the Reddit adapter
// (src/lib/sources/reddit/server/index.ts) now handles these URLs via
// the registry-driven parseAnyUrl iterator. The map is currently empty;
// future deferred platforms (Twitter / Telegram / Discord) repopulate it
// as the schema accepts those source kinds but no adapter exists yet.
import type { EventKind } from "./adapter.js";

const FUTURE_KIND_HOSTS = new Map<string, EventKind>([
  // (Reddit hosts removed in Phase 03.1 — adapter handles via registry.)
  // Twitter / Telegram / Discord remain out-of-scope for v1 (see
  // PROJECT.md §"Out of Scope"); their hosts aren't pasted in
  // production traffic at indie scale, so we don't pre-list them.
]);

export function detectFutureKind(input: string): EventKind | null {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase();
    return FUTURE_KIND_HOSTS.get(host) ?? null;
  } catch {
    return null;
  }
}

// Cross-source URL router.
//
// Iterates `allAdapters` from the registry in registration order; the
// first non-null `adapter.parseUrl(input)` wins. Returns `RoutedUrl`
// with `kind: "unsupported"` if no adapter matches.
//
// Registration order is therefore priority — load-bearing for the
// future case where two adapters could both claim a host (e.g. Telegram
// previews of YouTube videos). YouTube is registered first today
// (src/lib/sources/registry.ts) so it wins on `youtube.com` /
// `youtu.be` host matches and any future overlap is resolved by moving
// the more-specific adapter ahead of the more-general one.
//
// Reddit is registered as of Phase 03.1 plan 07 — `parseAnyUrl` returns
// `{ kind: "reddit_post", externalId, metadata }` for reddit.com /
// redd.it URLs via `redditAdapter.parseUrl`. Plan 09 wired
// services/ingest.ts to the synchronous /comments/<id>.json paste flow
// (D-RDT-INGEST-REPLACE), so the registry path is fully load-bearing
// end-to-end for Reddit ingest.
//
// `detectFutureKind` (src/lib/sources/future-kinds.ts) stays as the
// seam for the next deferred adapter (Twitter / Telegram / Discord) —
// the map is currently empty.

import { allAdapters } from "./registry.js";
import type { ParsedUrl } from "./adapter.js";

export type RoutedUrl = ParsedUrl | { kind: "unsupported" };

export function parseAnyUrl(input: string): RoutedUrl {
  for (const adapter of allAdapters) {
    const parsed = adapter.parseUrl(input);
    if (parsed !== null) return parsed;
  }
  return { kind: "unsupported" };
}

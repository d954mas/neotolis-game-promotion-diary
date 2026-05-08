// Cross-source URL router — Phase 03.0.1 Plan 06 (D-15).
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
// The friendly Reddit deferral message (RESEARCH.md SOTA divergence #3)
// is NOT added here. `parseAnyUrl` returns `{ kind: "unsupported" }`
// for reddit.com URLs (no Reddit adapter exists yet) and the
// orchestrator (`src/lib/server/services/url-parser.ts`) maps that to
// `{ kind: "reddit_deferred" }` via `detectFutureKind` from
// `./future-kinds.ts`. Keeping the Reddit-specific friendly path out
// of the registry-iteration layer means the iterator stays pure —
// adding Reddit (Phase 03.1) is a single registry entry and the
// `detectFutureKind` map shrinks accordingly.

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

// Reddit per-source adapter CORE — the public-`.json` model.
//
// `redditAdapterCore` is the polling slice composed
// into the full `redditAdapter` in ./index.ts (mirrors YouTube's
// adapter.ts → index.ts barrel pattern).
//
// Reddit doesn't expose synchronous pollContent / pollStats methods.
// Polling is queue-driven: backfillSource (./index.ts) and the
// type-specific worker handlers (sub-poll / author-poll / post-batch
// / post-single) own the enqueue + drain lifecycle. Earlier
// iterations carried YouTube-shaped pollContent / pollStats placeholder
// stubs here for legacy parity; they were never reached by any
// Reddit code path (verified by grep) and have been removed.
//
// parseUrl / parseSourceUrl stay on the core so the cross-source
// `parseAnyUrl` iterator and the /sources/new auto-detect can dispatch
// without instantiating the full barrel.

import type { AdapterObservability, ParsedSourceUrl, ParsedUrl } from "$lib/sources/adapter.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { redditObservability } from "./observability.js";

interface RedditAdapterCore {
  readonly kind: "reddit_account";
  parseUrl(url: string): ParsedUrl | null;
  parseSourceUrl(input: string): ParsedSourceUrl | null;
  readonly observability: AdapterObservability;
}

/** Reddit adapter polling core — URL parsers + observability surface.
 *
 *  Same adapter instance handles BOTH reddit_account and reddit_subreddit
 *  source kinds; registry.ts wires both keys to one redditAdapter object.
 *  Disambiguation happens in the barrel methods (backfillSource,
 *  onSourceCreated) based on source.metadata (username vs subreddit). */
export const redditAdapterCore: RedditAdapterCore = {
  // Declared kind matches the "primary" Reddit source kind; the registry
  // wires reddit_subreddit to the same instance. Cross-source code only
  // reads this field for diagnostic logs.
  kind: "reddit_account",

  parseUrl(input: string): ParsedUrl | null {
    return redditParsePostUrl(input);
  },

  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return redditParseSourceUrl(input);
  },

  observability: redditObservability,
};

// SourceRegistry — Map<SourceKind, DataSourceAdapter> populated by
// explicit per-source barrel imports.
//
// YouTube and Reddit are wired today; future per-platform adapters add
// entries here.
//
// reddit_account and reddit_subreddit BOTH map to the SAME redditAdapter
// instance — the adapter dispatches internally on source.metadata
// (username vs subreddit) inside pollContent / backfillSource. Two
// SourceKinds share one adapter because their backfill / refresh / cap
// semantics are identical (only the URL shape and the worker-handler
// route differ).
import type { DataSourceAdapter, SourceKind } from "./adapter.js";
import { youtubeAdapter } from "./youtube/server/index.js";
import { redditAdapter } from "./reddit/server/index.js";

// Registration ORDER is load-bearing for the first-match-wins parseAnyUrl
// iterator. YouTube first → wins on youtube.com / youtu.be host claims;
// Reddit after → wins on reddit.com / redd.it host claims. There's no
// overlap with YouTube hosts today, so order between these two adapters
// is symbolic but stable.
const registry = new Map<SourceKind, DataSourceAdapter>([
  ["youtube_channel", youtubeAdapter],
  ["reddit_account", redditAdapter],
  ["reddit_subreddit", redditAdapter],
]);

export function getAdapter(kind: SourceKind): DataSourceAdapter {
  const adapter = registry.get(kind);
  if (adapter === undefined) {
    throw new Error(`No adapter registered for kind=${kind as string}`);
  }
  return adapter;
}

/** Whether an adapter is registered for the given kind. Used by cross-source
 *  code that needs to call optional adapter methods (validateEventInput,
 *  fetchEventPreviewMetadata, etc.) without throwing on yet-to-be-implemented
 *  kinds. */
export function hasAdapter(kind: SourceKind): boolean {
  return registry.has(kind);
}

/** Iterating order is registration order — load-bearing for the
 *  first-match-wins URL router. */
export const allAdapters: DataSourceAdapter[] = Array.from(registry.values());

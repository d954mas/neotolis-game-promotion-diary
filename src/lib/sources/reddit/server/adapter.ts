// reddit adapter core (clone of twitter/server/adapter.ts, retargeted).
//
// The Core surface: the pure URL-parsing / observability / read methods any caller
// (the barrel, tests, the cross-source readers) uses directly. The
// infrastructure-touching methods (registerQueues / scheduleCronTicks /
// backfillSource) and create-time hooks (canonicalizeOnCreate / onSourceCreated /
// refreshQueue / fetchEventPreviewMetadata / resolveCachedExternalId) are COMPOSED in
// ./index.ts into the full `redditAdapter`. Cross-source code always imports
// `redditAdapter` from the barrel.
//
// ONE adapter object serves BOTH source kinds (reddit_account + reddit_subreddit) via
// the registry Map — their backfill / refresh / cap semantics are identical (only the
// ScrapeCreators feed mode + the URL shape differ, dispatched inside backfillSource).
// So `kind` here is the nominal "reddit_account"; the registry maps both kinds to this
// same object.
//
// PURE canonicalize (see index.ts): Reddit exposes no user-profile endpoint and the
// username/slug IS the immutable, rename-proof key, so there is NO
// resolveHandleToAccountId provider round-trip (unlike Twitter). The core carries only
// the URL parsers + observability + the three readers.

import { redditObservability } from "./observability.js";
import { redditParsePostUrl, redditParseSourceUrl } from "./url.js";
import { redditEnrichFeedDtos } from "./feed-enrichment.js";
import { redditFetchEventMetricSeries } from "./metric-series.js";
import { redditFetchPollStateMap } from "./poll-state.js";
import type {
  AdapterObservability,
  AdapterPollState,
  EventKind,
  EventMetricSeries,
  ParsedSourceUrl,
  ParsedUrl,
} from "$lib/sources/adapter.js";
import type { EventDto } from "$lib/server/dto.js";

interface RedditAccountAdapterCore {
  readonly kind: "reddit_account";
  parseUrl(url: string): ParsedUrl | null;
  parseSourceUrl(input: string): ParsedSourceUrl | null;
  readonly observability: AdapterObservability;
  enrichFeedDtos(userId: string, dtos: EventDto[]): Promise<void>;
  fetchEventMetricSeries(
    userId: string,
    event: { kind: EventKind; externalId: string | null },
  ): Promise<EventMetricSeries[]>;
  fetchPollStateMap(
    userId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, AdapterPollState>>;
}

export const redditAccountAdapterCore: RedditAccountAdapterCore = {
  kind: "reddit_account" as const,
  parseUrl(url: string): ParsedUrl | null {
    return redditParsePostUrl(url);
  },
  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return redditParseSourceUrl(input);
  },
  observability: redditObservability,
  enrichFeedDtos: redditEnrichFeedDtos,
  fetchEventMetricSeries: redditFetchEventMetricSeries,
  fetchPollStateMap: redditFetchPollStateMap,
};

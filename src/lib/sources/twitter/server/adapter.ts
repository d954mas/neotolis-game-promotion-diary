// twitter_account adapter core.
//
// The Core surface (mirrors tiktokAccountAdapterCore): the pure URL-parsing /
// observability / read methods any caller (the barrel, tests, the cross-source
// readers) uses directly. The infrastructure-touching methods (registerQueues /
// scheduleCronTicks / backfillSource) and create-time hooks (canonicalizeOnCreate /
// onSourceCreated / resetWalkerStateOnWidening / refreshQueue /
// fetchEventPreviewMetadata) are COMPOSED in ./index.ts into the full
// `twitterAdapter`. Cross-source code always imports `twitterAdapter` from the barrel.
//
// SINGLE-FEED: the Twitter walker is single-feed and calls fetchTwitterFeedPageWithRaw
// directly (handlers/backfill-account.ts). So this core carries no pollContent — only
// resolveHandleToAccountId (the create-time profile resolve that ALSO seeds the
// subject entity) + the URL parsers + observability + the three readers.

import { getSocialProvider } from "./provider/registry.js";
import { twitterObservability } from "./observability.js";
import { twitterParseUrl, twitterParseSourceUrl } from "./url.js";
import { twitterEnrichFeedDtos } from "./feed-enrichment.js";
import { twitterFetchEventMetricSeries } from "./metric-series.js";
import { twitterFetchPollStateMap } from "./poll-state.js";
import { upsertTwitterAccount } from "./snapshots.js";
import { logger } from "$lib/server/logger.js";
import type {
  AdapterObservability,
  AdapterPollState,
  EventKind,
  EventMetricSeries,
  ParsedSourceUrl,
  ParsedUrl,
} from "$lib/sources/adapter.js";
import type { EventDto } from "$lib/server/dto.js";

interface TwitterAccountAdapterCore {
  readonly kind: "twitter_account";
  /** Resolve a user-pasted handle → the stable Twitter account_id (the channelKey).
   *  Used by canonicalizeOnCreate (barrel). ALSO seeds the twitter_accounts subject
   *  entity from the SAME profile response (no extra credit). Returns null when not
   *  configured OR the handle is missing/suspended (11-SPIKE.md Q3: HTTP 200 + `data:
   *  null` → null-by-presence in normalizeProfile). */
  resolveHandleToAccountId(
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null>;
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

export const twitterAccountAdapterCore: TwitterAccountAdapterCore = {
  kind: "twitter_account" as const,

  async resolveHandleToAccountId(
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null> {
    const provider = getSocialProvider("twitter");
    if (provider === null) return null;
    const resolved = await provider.resolveAccount("twitter", handle);
    if (resolved === null) return null;
    // Populate the account subject entity from the SAME profile response we just paid
    // for (no extra credit) — name / avatar / follower_count / username. The
    // COALESCE-preserving UPSERT means a later cheap feed refresh never blanks these
    // richer fields. Best-effort: a failed entity write must not block source creation
    // (the caller only needs accountId/displayName).
    try {
      await upsertTwitterAccount({
        accountId: resolved.accountId,
        username: resolved.username,
        name: resolved.fullName,
        avatarUrl: resolved.avatarUrl,
        followerCount: resolved.followerCount,
      });
    } catch (err) {
      logger.warn(
        { handle, accountId: resolved.accountId, err: String((err as Error)?.message ?? err) },
        "twitter.resolveHandleToAccountId: twitter_accounts UPSERT failed (non-fatal)",
      );
    }
    return { accountId: resolved.accountId, displayName: resolved.displayName };
  },

  parseUrl(url: string): ParsedUrl | null {
    return twitterParseUrl(url);
  },
  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return twitterParseSourceUrl(input);
  },
  observability: twitterObservability,
  enrichFeedDtos: twitterEnrichFeedDtos,
  fetchEventMetricSeries: twitterFetchEventMetricSeries,
  fetchPollStateMap: twitterFetchPollStateMap,
};

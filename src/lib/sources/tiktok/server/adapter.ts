// tiktok_account adapter core.
//
// The Core surface (mirrors instagramAccountAdapterCore): the pure
// URL-parsing / observability / read methods any caller (the barrel, tests, the
// cross-source readers) uses directly. The infrastructure-touching methods
// (registerQueues / scheduleCronTicks / backfillSource) and create-time hooks
// (canonicalizeOnCreate / onSourceCreated / resetWalkerStateOnWidening /
// refreshQueue / fetchEventPreviewMetadata) are COMPOSED in ./index.ts into the
// full `tiktokAdapter`. Cross-source code always imports `tiktokAdapter` from the
// barrel.
//
// SINGLE-FEED: unlike Instagram (whose adapter core exposes a feed-aware
// pollContent the two-feed walker drives), the TikTok walker is single-feed and
// calls provider.fetchPosts directly (handlers/backfill-account.ts). So this core
// carries no pollContent — only resolveHandleToAccountId (the create-time profile
// resolve that ALSO seeds the subject entity) + the URL parsers + observability +
// the three readers.

import { getSocialProvider } from "./provider/registry.js";
import { tiktokObservability } from "./observability.js";
import { tiktokParseUrl, tiktokParseSourceUrl } from "./url.js";
import { tiktokEnrichFeedDtos } from "./feed-enrichment.js";
import { tiktokFetchEventMetricSeries } from "./metric-series.js";
import { tiktokFetchPollStateMap } from "./poll-state.js";
import { upsertTikTokAccount } from "./snapshots.js";
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

interface TikTokAccountAdapterCore {
  readonly kind: "tiktok_account";
  /** Resolve a user-pasted handle → the stable TikTok account_id (the channelKey).
   *  Used by canonicalizeOnCreate (barrel). ALSO seeds the tiktok_accounts subject
   *  entity from the SAME profile response (no extra credit). Returns null when not
   *  configured OR the handle is missing/private (10-SPIKE.md: HTTP 200 + no `user`
   *  → null-by-presence in normalizeProfile). */
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

export const tiktokAccountAdapterCore: TikTokAccountAdapterCore = {
  kind: "tiktok_account" as const,

  async resolveHandleToAccountId(
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null> {
    const provider = getSocialProvider("tiktok");
    if (provider === null) return null;
    const resolved = await provider.resolveAccount("tiktok", handle);
    if (resolved === null) return null;
    // Populate the account subject entity from the SAME profile response we just
    // paid for (no extra credit) — nickname / avatar / follower_count / username /
    // sec_uid. The COALESCE-preserving UPSERT means a later cheap feed refresh never
    // blanks these richer fields. Best-effort: a failed entity write must not block
    // source creation (the caller only needs accountId/displayName).
    try {
      await upsertTikTokAccount({
        accountId: resolved.accountId,
        username: resolved.username,
        nickname: resolved.fullName,
        avatarUrl: resolved.avatarUrl,
        followerCount: resolved.followerCount,
        secUid: resolved.secUid ?? null,
      });
    } catch (err) {
      logger.warn(
        { handle, accountId: resolved.accountId, err: String((err as Error)?.message ?? err) },
        "tiktok.resolveHandleToAccountId: tiktok_accounts UPSERT failed (non-fatal)",
      );
    }
    return { accountId: resolved.accountId, displayName: resolved.displayName };
  },

  parseUrl(url: string): ParsedUrl | null {
    return tiktokParseUrl(url);
  },
  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return tiktokParseSourceUrl(input);
  },
  observability: tiktokObservability,
  enrichFeedDtos: tiktokEnrichFeedDtos,
  fetchEventMetricSeries: tiktokFetchEventMetricSeries,
  fetchPollStateMap: tiktokFetchPollStateMap,
};

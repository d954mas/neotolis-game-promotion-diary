// instagram_account adapter core.
//
// The Core surface (mirrors youtubeChannelAdapterCore): the pure
// polling / URL-parsing / observability methods any caller (the walker handler,
// tests, the cross-source readers) uses directly. The infrastructure-touching
// methods (registerQueues / scheduleCronTicks / backfillSource) and create-time
// hooks (canonicalizeOnCreate / onSourceCreated / resetWalkerStateOnWidening /
// refreshQueue) are COMPOSED in ./index.ts into the full `instagramAdapter`.
// Cross-source code always imports `instagramAdapter` from the barrel.
//
// pollContent walks ONE provider page (BACK-02): it asks the SocialProvider
// (Plan 02) for one page of posts OR reels (kindFilter), maps each
// NormalizedPost → RawEvent (the provider-shape→event mapping lives HERE, SOC-04
// — nothing above the adapter sees a ScrapeCreators field), writes each post's
// snapshot + public-data cache row via writeSnapshot (Plan 03), and returns the
// uniform cursor (nextCursor) + endOfFeed the provider already absorbed the
// posts-vs-reels divergence into.
//
// The credit reservation (reserve-before-HTTP, BUDGET-02) happens inside the
// provider's HTTP seam (http.ts) when ctx.origin is threaded through — so every
// page counts against the operator prepaid budget and the walker never
// over-spends. A null permit surfaces as an AdapterError the walker catches to
// pause + persist its cursor.

import { getSocialProvider } from "./provider/registry.js";
import { instagramObservability } from "./observability.js";
import { instagramParseUrl, instagramParseSourceUrl } from "./url.js";
import { instagramEnrichFeedDtos } from "./feed-enrichment.js";
import { instagramFetchEventMetricSeries } from "./metric-series.js";
import { instagramFetchPollStateMap } from "./poll-state.js";
import { writeSnapshot, upsertInstagramAccount } from "./snapshots.js";
import { logger } from "$lib/server/logger.js";
import type {
  AdapterObservability,
  AdapterPollState,
  EventKind,
  EventMetricSeries,
  ParsedSourceUrl,
  ParsedUrl,
  PollableSource,
  RawEvent,
} from "$lib/sources/adapter.js";
import type { EventDto } from "$lib/server/dto.js";
import type { FeedOwner, NormalizedPost, ProviderOrigin } from "$lib/sources/social-provider.js";

/** Which feed this page reads. The walker drives both feeds (posts then reels),
 *  each its own cursor stream + its own end-of-feed sub-state. */
export type InstagramFeed = "posts" | "reels";

export interface InstagramPollContext {
  origin?: ProviderOrigin;
  /** Which feed to page. Defaults to "posts". */
  feed?: InstagramFeed;
  /** Resume cursor for this feed (ProviderPage.nextCursor from the prior tick),
   *  or null/undefined to start at page 1. */
  cursor?: string | null;
}

export interface InstagramPollResult {
  events: RawEvent[];
  unitsUsed: number;
  /** Uniform cursor (next_max_id for posts / paging_info.max_id for reels —
   *  the divergence died in the provider seam). null at end of feed. */
  nextCursor: string | null;
  endOfFeed: boolean;
  /** The FREE feed owner object (the account whose feed this page is) — the
   *  walker UPSERTs instagram_accounts from it with NO extra credit. null when
   *  the response omitted the owner (e.g. the reels feed). */
  owner: FeedOwner | null;
}

/** D-09: the event title is the caption's FIRST line. Falls back to the IG
 *  fallback ("Instagram <mediaType> · <date>") when the post is caption-less.
 *  Built server-side (the worker never does i18n — the canonical title is
 *  stored at insert time; the UI renders it verbatim, mirroring YouTube/Reddit
 *  titles). The fallback string mirrors messages/en.json
 *  event_title_instagram_fallback. */
function buildTitle(post: NormalizedPost): string {
  const caption = post.caption?.trim();
  if (caption !== undefined && caption !== "") {
    const firstLine = caption.split("\n", 1)[0]!.trim();
    if (firstLine !== "") return firstLine;
  }
  const date = post.publishedAt.toISOString().slice(0, 10);
  return `Instagram ${post.kind} · ${date}`;
}

/** Map a NormalizedPost → cross-source RawEvent. The ScrapeCreators field shape
 *  is already gone (the provider seam returns NormalizedPost); this is the
 *  NormalizedPost → events mapping (SOC-04). */
function postToRawEvent(post: NormalizedPost): RawEvent {
  return {
    externalId: post.id,
    url: post.permalink ?? `https://www.instagram.com/p/${post.id}/`,
    title: buildTitle(post),
    occurredAt: post.publishedAt,
    kind: "instagram_post",
    metadata: {
      media_type: post.kind,
      thumbnail_url: post.thumbnailUrl,
      caption: post.caption,
    },
  };
}

interface InstagramAccountAdapterCore {
  readonly kind: "instagram_account";
  pollContent(
    source: PollableSource,
    since: Date,
    ctx?: InstagramPollContext,
  ): Promise<InstagramPollResult>;
  /** Resolve a user-pasted handle → the stable IG account_id (the channelKey).
   *  Used by canonicalizeOnCreate (barrel). Returns null when not configured OR
   *  the handle is missing/private. */
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

export const instagramAccountAdapterCore: InstagramAccountAdapterCore = {
  kind: "instagram_account" as const,

  /**
   * Walk ONE page of one feed (BACK-02). Resolves the provider (null →
   * graceful degrade, SOC-05); asks for one page; maps each NormalizedPost →
   * RawEvent; writes each post's snapshot + cache row (Plan 03); returns the
   * uniform cursor + endOfFeed.
   *
   * `since` is the depth boundary the WALKER enforces (date window) — it is
   * passed through for the caller's bound check, NOT applied here (the page is
   * returned whole so the walker can decide post-by-post where to stop and how
   * many to count toward the post-count cap).
   *
   * NOTE: the source's handle lives on data_sources.metadata. The walker passes
   * the resolved handle in `source.metadata.handle` (the user-pasted slug, used
   * only as the provider query param — the channelKey is the resolved
   * account_id and lives on data_sources.metadata.accountId, NEVER here).
   */
  async pollContent(
    source: PollableSource,
    _since: Date,
    ctx?: InstagramPollContext,
  ): Promise<InstagramPollResult> {
    const provider = getSocialProvider("instagram");
    if (provider === null) {
      // SOC-05 graceful degrade — provider not configured.
      logger.info(
        { sourceId: source.id, userId: source.userId },
        "instagram.pollContent: provider not configured; degrading to empty",
      );
      return { events: [], unitsUsed: 0, nextCursor: null, endOfFeed: true, owner: null };
    }

    const handle = (source.metadata as { handle?: string })?.handle;
    if (typeof handle !== "string" || handle === "") {
      logger.warn(
        { sourceId: source.id, userId: source.userId },
        "instagram.pollContent: source.metadata.handle missing; cannot poll",
      );
      return { events: [], unitsUsed: 0, nextCursor: null, endOfFeed: true, owner: null };
    }

    const feed: InstagramFeed = ctx?.feed ?? "posts";
    const cursor = ctx?.cursor ?? null;

    // ONE provider page. The credit reservation runs inside the provider's HTTP
    // seam (http.ts) when ctx.origin is set — a null permit throws AdapterError
    // (operator-issue / rate-limited) which propagates to the walker to pause +
    // persist the cursor.
    const page = await provider.fetchPosts("instagram", handle, cursor, {
      kindFilter: feed,
      origin: ctx?.origin,
    });

    const events: RawEvent[] = [];
    for (const post of page.posts) {
      events.push(postToRawEvent(post));
      // Write the public-data cache + (on 'ok') the snapshot row. This is the
      // single-source-of-truth UPSERT the cross-source readers (Plan 04) read.
      await writeSnapshot({
        postId: post.id,
        accountId: (source.metadata as { accountId?: string })?.accountId ?? null,
        mediaType: post.kind,
        caption: post.caption,
        permalink: post.permalink,
        thumbnailUrl: post.thumbnailUrl,
        publishedAt: post.publishedAt,
        metrics: {
          views: post.metrics.views,
          likes: post.metrics.likes,
          comments: post.metrics.comments,
        },
        status: "ok",
      });
    }

    return {
      events,
      unitsUsed: page.creditsUsed,
      nextCursor: page.nextCursor,
      endOfFeed: page.endOfFeed,
      owner: page.owner ?? null,
    };
  },

  async resolveHandleToAccountId(
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null> {
    const provider = getSocialProvider("instagram");
    if (provider === null) return null;
    const resolved = await provider.resolveAccount("instagram", handle);
    if (resolved === null) return null;
    // Populate the account subject entity from the SAME profile response we just
    // paid for (no extra credit) — full_name / avatar / follower_count /
    // username. The COALESCE-preserving UPSERT means a later cheap feed refresh
    // never blanks these richer fields. Best-effort: a failed entity write must
    // not block source creation (the caller only needs accountId/displayName).
    try {
      await upsertInstagramAccount({
        accountId: resolved.accountId,
        username: resolved.username,
        fullName: resolved.fullName,
        avatarUrl: resolved.avatarUrl,
        followerCount: resolved.followerCount,
      });
    } catch (err) {
      logger.warn(
        { handle, accountId: resolved.accountId, err: String((err as Error)?.message ?? err) },
        "instagram.resolveHandleToAccountId: instagram_accounts UPSERT failed (non-fatal)",
      );
    }
    return resolved;
  },

  parseUrl(url: string): ParsedUrl | null {
    return instagramParseUrl(url);
  },
  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return instagramParseSourceUrl(input);
  },
  observability: instagramObservability,
  enrichFeedDtos: instagramEnrichFeedDtos,
  fetchEventMetricSeries: instagramFetchEventMetricSeries,
  fetchPollStateMap: instagramFetchPollStateMap,
};

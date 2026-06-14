// Twitter/X feed-enrichment hook (VIZ-05 feed surface) — clone of tiktok/server/
// feed-enrichment.ts with the D-05 shareCount delta + the Twitter thumbnail hotlink
// decision.
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos iterator.
// Mutates EventDto rows in place for kind='twitter_post' entries; ignores other
// kinds — callers do NOT pre-filter (internal filtering is the contract).
//
// Three batched lookups, all PUBLIC-DATA / channel-global (no userId scope; the
// tenant guarantee comes from the events SELECT in mapEventsToDtos):
//   1. twitter_post_snapshots — DISTINCT ON (tweet_id) latest view / like / comment
//      / SHARE counts. Raw SQL (Drizzle has no DISTINCT ON helper). share_count is
//      the DERIVED retweet+quote sum (D-05).
//   2. twitter_posts — per-tweet thumbnail_url + media_type + account_id.
//   3. data_source_channel_state — the per-account operator-budget-paused hint
//      (BUDGET-01). The walker flips metadata.twitter.operatorPaused on the account's
//      channel-state row (source of truth); we overlay it onto each event's
//      metadata.operator_paused so the PollingBadge renders the paused variant.
//
// THUMBNAIL (11-SPIKE.md Q6 — DOCS-ONLY, hotlink-first, NO proxy): pbs.twimg.com is
// historically permissive (no Cross-Origin-Resource-Policy: same-origin, unlike
// TikTok's CDN), so Twitter HOTLINKS the raw cover URL directly (D-06/D-08 hotlink +
// onerror). Unlike TikTok (whose CDN is ORB-blocked → a same-origin proxy), NO
// thumbnail proxy is built. The Q6 browser renderability test is owed at Plan 04
// UAT (mirror TikTok's Plan-05 step); if pbs.twimg.com turns out CORP-blocked there,
// a same-origin proxy is added then (the seam is the same as TikTok's). This reader
// hangs the RAW pbs.twimg.com URL on thumbnailUrl.
//
// Metrics-by-presence (D-05): a NULL snapshot column stays NULL on the dto (a
// protected/limited tweet may omit impressions → null, NOT 0). The shareCount is
// also independently nullable.
//
// NO denormalization of the Twitter @handle / display name here (AGENTS.md). The
// handle / account display name lives on data_sources / twitter_accounts; the card
// reads it from the `source` prop at render time. This reader carries account_id
// (the intrinsic Twitter user id, URL-identity-safe) but never a renameable display
// value.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { twitterPosts } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export interface TwitterEnrichment {
  /** Latest view / like / comment / SHARE from the most-recent
   *  twitter_post_snapshots row. NULL when no snapshot exists yet. Each metric is
   *  INDEPENDENTLY nullable: metrics-by-presence (D-05) — viewCount/shareCount are
   *  null for protected/limited tweets that don't surface them, NEVER coerced to 0.
   *  shareCount is the DERIVED retweet+quote sum. */
  stats: {
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    shareCount: number | null;
    polledAt: Date;
  } | null;
  /** The raw pbs.twimg.com cover URL from twitter_posts.thumbnail_url (photo or
   *  video poster). HOTLINKED directly (11-SPIKE.md Q6 — pbs.twimg.com is
   *  permissive; NO proxy, unlike TikTok). NULL until the tweet is resolved. */
  thumbnailUrl: string | null;
  /** Content form from twitter_posts.media_type ("video" | "image" | "text", D-06).
   *  Drives the per-form card affordance + the cross-source media-type filter. NULL
   *  until resolved. */
  mediaType: string | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper (Plan 04)
 *  reads the same key via the same cast shape. */
type TwitterDecorated = EventDto & { twitterEnrichment?: TwitterEnrichment };

export async function twitterEnrichFeedDtos(
  /** userId required by the SourceAdapter.enrichFeedDtos contract; unused here
   *  because both Twitter tables are PUBLIC-DATA. Tenant scope comes from the
   *  upstream events SELECT in mapEventsToDtos. */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const twDtos = dtos.filter((d) => d.kind === "twitter_post" && d.externalId !== null);
  if (twDtos.length === 0) return;
  const externalIds = twDtos.map((d) => d.externalId as string);

  try {
    // 1. Latest snapshot per tweet_id. twitter_post_snapshots is an immutable time
    //    series — a tracked tweet accrues one row per poll. DISTINCT ON keeps the
    //    scan tight: exactly one row per tweet_id, the most recent.
    const idsSql = sql.join(
      externalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    // Queries 1 + 2 are independent (both key on externalIds) — run them
    // concurrently. Query 3 (operator-paused) depends on accountIds from query 2.
    const [latestRows, postRows] = await Promise.all([
      db.execute<{
        tweet_id: string;
        polled_at: Date;
        view_count: number | null;
        like_count: number | null;
        comment_count: number | null;
        share_count: number | null;
      }>(sql`
        SELECT DISTINCT ON (tweet_id)
          tweet_id, polled_at, view_count, like_count, comment_count, share_count
        FROM twitter_post_snapshots
        WHERE tweet_id IN (${idsSql})
        ORDER BY tweet_id, polled_at DESC
      `),
      // 2. Thumbnail + media_type + account_id from twitter_posts (post-keyed
      //    public-data). NO account display name read here (no-denorm rule).
      db
        .select({
          tweetId: twitterPosts.tweetId,
          thumbnailUrl: twitterPosts.thumbnailUrl,
          mediaType: twitterPosts.mediaType,
          accountId: twitterPosts.accountId,
        })
        .from(twitterPosts)
        .where(inArray(twitterPosts.tweetId, externalIds)),
    ]);
    const latest = new Map<string, TwitterEnrichment["stats"]>();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — bigint columns come back as
      // strings; Number() coerces a present value, null STAYS null
      // (metrics-by-presence D-05).
      latest.set(s.tweet_id, {
        viewCount: s.view_count === null ? null : Number(s.view_count),
        likeCount: s.like_count === null ? null : Number(s.like_count),
        commentCount: s.comment_count === null ? null : Number(s.comment_count),
        // The DERIVED share metric (retweet+quote), presence-mapped.
        shareCount: s.share_count === null ? null : Number(s.share_count),
        polledAt:
          s.polled_at instanceof Date ? s.polled_at : new Date(s.polled_at as unknown as string),
      });
    }

    const postMeta = new Map<
      string,
      { thumbnailUrl: string | null; mediaType: string | null; accountId: string | null }
    >();
    for (const r of postRows) {
      postMeta.set(r.tweetId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaType: r.mediaType,
        accountId: r.accountId,
      });
    }

    // 3. Operator-budget-paused accounts (BUDGET-01). The walker flips
    //    metadata.twitter.operatorPaused on the per-account channel-state row when a
    //    poll/backfill tick is paused by the operator's prepaid budget, and clears it
    //    on a successful unpaused tick. We overlay it onto each event's
    //    metadata.operator_paused so the PollingBadge lights up. NO per-event
    //    denormalization: one channel-state row drives every event of the account.
    const accountIds = [
      ...new Set(
        postRows.map((r) => r.accountId).filter((id): id is string => id !== null && id !== ""),
      ),
    ];
    const pausedAccounts = new Set<string>();
    if (accountIds.length > 0) {
      const stateRows = await db
        .select({
          channelKey: dataSourceChannelState.channelKey,
          metadata: dataSourceChannelState.metadata,
        })
        .from(dataSourceChannelState)
        .where(
          and(
            eq(dataSourceChannelState.kind, "twitter_account"),
            inArray(dataSourceChannelState.channelKey, accountIds),
          ),
        );
      for (const r of stateRows) {
        const tw = (r.metadata as { twitter?: { operatorPaused?: unknown } } | null)?.twitter;
        if (tw?.operatorPaused === true) pausedAccounts.add(r.channelKey);
      }
    }

    // In-place decoration. Attach twitterEnrichment to each filtered dto; the
    // card-props mapper (Plan 04) reads the same shape. The operator-paused hint is
    // merged into the DTO's metadata (NOT the decoration) because the PollingBadge
    // reads event.metadata.operator_paused.
    for (const dto of twDtos) {
      const eid = dto.externalId as string;
      const meta = postMeta.get(eid) ?? null;
      (dto as TwitterDecorated).twitterEnrichment = {
        stats: latest.get(eid) ?? null,
        thumbnailUrl: meta?.thumbnailUrl ?? null,
        mediaType: meta?.mediaType ?? null,
      };
      if (
        meta?.accountId !== null &&
        meta?.accountId !== undefined &&
        pausedAccounts.has(meta.accountId)
      ) {
        const base =
          dto.metadata !== null && typeof dto.metadata === "object"
            ? (dto.metadata as Record<string, unknown>)
            : {};
        dto.metadata = { ...base, operator_paused: true };
      }
    }
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: twDtos.length },
      "twitter.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}

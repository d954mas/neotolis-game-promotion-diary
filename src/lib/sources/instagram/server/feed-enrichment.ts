// Instagram feed-enrichment hook (VIZ-05 feed surface).
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos iterator
// (cross-source contract). Mutates EventDto rows in place for
// kind='instagram_post' entries; ignores other kinds — callers do NOT
// pre-filter, internal filtering is the contract (mirrors
// youtube/reddit enrichFeedDtos).
//
// Three batched lookups, all PUBLIC-DATA / channel-global (no userId scope —
// allowlisted in Plan 01; the tenant guarantee comes from the events SELECT in
// mapEventsToDtos):
//   1. instagram_post_snapshots — DISTINCT ON (post_id) latest view / like /
//      comment counts. Raw SQL because Drizzle's pg-core builder has no
//      first-class DISTINCT ON helper (same as youtubeEnrichFeedDtos).
//   2. instagram_posts — per-post thumbnail_url + media_type (D-08 hotlink
//      thumbnail refreshed each poll) + account_id (the channel key).
//   3. data_source_channel_state — the per-account operator-budget-paused hint
//      (BUDGET-01). The walker flips metadata.instagram.operatorPaused on the
//      account's channel-state row (source of truth) when polling is paused by
//      the operator's prepaid budget; we overlay it onto each event's
//      metadata.operator_paused so the PollingBadge renders the "Paused ·
//      operator budget reached" variant. No per-event denormalization — one
//      channel-state row drives every event of the account.
//
// Metrics-by-presence (D-05): a NULL snapshot column stays NULL on the dto
// (a photo / carousel has no views → null, NOT 0). The UI renders only the
// non-null metrics. This is why the decoration's view/like/comment fields
// are `number | null`, distinct from the YouTube `stats` triple (which
// coerces null→0 and types as `number`).
//
// NO denormalization of the IG handle / display name here (AGENTS.md
// no-denorm rule). The handle / account display name lives on data_sources
// (the source-of-truth row); the IG feed card reads it from the `source`
// prop at render time (exactly as the YouTube / Reddit cards read
// data_sources.channelTitle / displayName) so an account rename reflects
// everywhere without a per-post re-walk. This reader only touches
// post-keyed public-data; it carries account_id (the intrinsic IG user id,
// URL-identity-safe) but never a renameable display value.
//
// Decoration shape (attached via cast — EventDto stays unchanged, mirroring
// the Reddit redditEnrichment pattern): we hang an `instagramEnrichment`
// property on the dto object. The UI mapper (Plan 07 ui/card-props.ts) reads
// via the same cast shape; no schema changes to EventDto.
//
// Errors are swallowed at WARN — a failed enrichment query MUST NOT break
// the /feed render. The card falls back to a stats-less view.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export interface InstagramEnrichment {
  /** Latest view / like / comment from the most-recent
   *  instagram_post_snapshots row. NULL when no snapshot exists yet (worker
   *  hasn't polled this post). Each metric is INDEPENDENTLY nullable:
   *  metrics-by-presence (D-05) — viewCount is null for photos / carousels
   *  (Instagram exposes play_count only on reels/video), NEVER coerced to 0. */
  stats: {
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    polledAt: Date;
  } | null;
  /** The fresh IG CDN thumbnail URL (D-08 hotlink) from
   *  instagram_posts.thumbnail_url. Expires; refreshed every poll by the
   *  snapshot writer. NULL until the post is resolved. */
  thumbnailUrl: string | null;
  /** Content form from instagram_posts.media_type ("image" | "carousel" |
   *  "video" | "reel", D-06). Drives the per-form card affordance (reel play
   *  badge vs carousel stack). NULL until resolved. */
  mediaType: string | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper
 *  (Plan 07) reads the same key via the same cast shape. */
type InstagramDecorated = EventDto & { instagramEnrichment?: InstagramEnrichment };

export async function instagramEnrichFeedDtos(
  /** userId required by the SourceAdapter.enrichFeedDtos contract; unused
   *  here because both IG tables are PUBLIC-DATA. Tenant scope comes from
   *  the upstream events SELECT in mapEventsToDtos. */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const igDtos = dtos.filter((d) => d.kind === "instagram_post" && d.externalId !== null);
  if (igDtos.length === 0) return;
  const externalIds = igDtos.map((d) => d.externalId as string);

  try {
    // 1. Latest snapshot per post_id. instagram_post_snapshots is an
    //    immutable time series — a tracked post accrues one row per poll.
    //    DISTINCT ON (post_id) ORDER BY post_id, polled_at DESC keeps the
    //    scan tight: exactly one row per requested post_id, the most recent.
    //    Raw SQL because Drizzle's pg-core builder has no DISTINCT ON helper.
    const idsSql = sql.join(
      externalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const latestRows = await db.execute<{
      post_id: string;
      polled_at: Date;
      view_count: number | null;
      like_count: number | null;
      comment_count: number | null;
    }>(sql`
      SELECT DISTINCT ON (post_id)
        post_id, polled_at, view_count, like_count, comment_count
      FROM instagram_post_snapshots
      WHERE post_id IN (${idsSql})
      ORDER BY post_id, polled_at DESC
    `);
    const latest = new Map<string, InstagramEnrichment["stats"]>();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — bigint columns come back
      // as strings; Number() coerces a present value, null STAYS null
      // (metrics-by-presence D-05: a photo's views is null, never 0).
      latest.set(s.post_id, {
        viewCount: s.view_count === null ? null : Number(s.view_count),
        likeCount: s.like_count === null ? null : Number(s.like_count),
        commentCount: s.comment_count === null ? null : Number(s.comment_count),
        polledAt:
          s.polled_at instanceof Date ? s.polled_at : new Date(s.polled_at as unknown as string),
      });
    }

    // 2. Thumbnail + media_type + account_id from instagram_posts (post-keyed
    //    public-data). NO account display name read here — the handle lives on
    //    data_sources and the card reads it from the `source` prop (no-denorm
    //    rule). account_id IS carried — it is the intrinsic IG account key
    //    (= data_source_channel_state.channelKey), URL-identity-safe, not a
    //    renameable display value — and lets us resolve the account's
    //    operator-budget-paused hint below (BUDGET-01) without touching
    //    data_sources.
    const postRows = await db
      .select({
        postId: instagramPosts.postId,
        thumbnailUrl: instagramPosts.thumbnailUrl,
        mediaType: instagramPosts.mediaType,
        accountId: instagramPosts.accountId,
      })
      .from(instagramPosts)
      .where(inArray(instagramPosts.postId, externalIds));
    const postMeta = new Map<
      string,
      { thumbnailUrl: string | null; mediaType: string | null; accountId: string | null }
    >();
    for (const r of postRows) {
      postMeta.set(r.postId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaType: r.mediaType,
        accountId: r.accountId,
      });
    }

    // 3. Operator-budget-paused accounts (BUDGET-01). The walker flips
    //    metadata.instagram.operatorPaused on the per-account channel-state row
    //    (the source of truth) when a poll/backfill tick is paused by the
    //    operator's prepaid budget, and clears it on a successful unpaused tick.
    //    We read that flag here and overlay it onto each event's
    //    metadata.operator_paused so the PollingBadge lights up — exactly the
    //    way fetchPollStateMap overlays publishedAt/lastPolledAt. NO per-event
    //    denormalization: one channel-state row drives every event of the
    //    account. data_source_channel_state carries no user_id (channel-global,
    //    like instagram_posts); the tenant guarantee comes from the upstream
    //    events SELECT in mapEventsToDtos.
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
            eq(dataSourceChannelState.kind, "instagram_account"),
            inArray(dataSourceChannelState.channelKey, accountIds),
          ),
        );
      for (const r of stateRows) {
        const ig = (r.metadata as { instagram?: { operatorPaused?: unknown } } | null)?.instagram;
        if (ig?.operatorPaused === true) pausedAccounts.add(r.channelKey);
      }
    }

    // In-place decoration. Iterate the filtered subset and attach
    // instagramEnrichment to each; the card-props mapper (Plan 07) reads the
    // same shape. The operator-paused hint is merged into the DTO's metadata
    // (NOT the decoration) because the PollingBadge reads
    // event.metadata.operator_paused — the same verbatim-projected events.metadata
    // column it reads for every kind.
    for (const dto of igDtos) {
      const eid = dto.externalId as string;
      const meta = postMeta.get(eid) ?? null;
      (dto as InstagramDecorated).instagramEnrichment = {
        stats: latest.get(eid) ?? null,
        thumbnailUrl: meta?.thumbnailUrl ?? null,
        mediaType: meta?.mediaType ?? null,
      };
      if (meta?.accountId !== null && meta?.accountId !== undefined && pausedAccounts.has(meta.accountId)) {
        const base =
          dto.metadata !== null && typeof dto.metadata === "object"
            ? (dto.metadata as Record<string, unknown>)
            : {};
        dto.metadata = { ...base, operator_paused: true };
      }
    }
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: igDtos.length },
      "instagram.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}

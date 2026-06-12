// TikTok feed-enrichment hook (VIZ-05 feed surface) — clone of instagram/server/
// feed-enrichment.ts with the PLAT-02 shareCount delta + the TikTok thumbnail
// hotlink decision.
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos iterator.
// Mutates EventDto rows in place for kind='tiktok_post' entries; ignores other
// kinds — callers do NOT pre-filter (internal filtering is the contract).
//
// Three batched lookups, all PUBLIC-DATA / channel-global (no userId scope; the
// tenant guarantee comes from the events SELECT in mapEventsToDtos):
//   1. tiktok_post_snapshots — DISTINCT ON (aweme_id) latest view / like / comment
//      / SHARE counts. Raw SQL (Drizzle has no DISTINCT ON helper). share_count is
//      the PLAT-02 delta vs IG.
//   2. tiktok_posts — per-post thumbnail_url + media_type + account_id.
//   3. data_source_channel_state — the per-account operator-budget-paused hint
//      (BUDGET-01). The walker flips metadata.tiktok.operatorPaused on the
//      account's channel-state row (source of truth); we overlay it onto each
//      event's metadata.operator_paused so the PollingBadge renders the paused
//      variant. No per-event denormalization.
//
// THUMBNAIL (10-SPIKE.md Q3 — RESOLVED at Plan 05 UAT): the TikTok cover on
// tiktokcdn-us.com (signed + expiring, .awebp preferred over .heic) is hotlink-
// BLOCKED in a real browser (net::ERR_BLOCKED_BY_ORB; server-side fetch of the
// same URL returns 200), so a same-origin proxy was added (mirroring IG's #69).
// This reader still hangs the RAW CDN cover URL on thumbnailUrl — the proxy
// rewrite happens at the card/chart seam (deriveThumbnailUrl / eventThumbnail),
// keyed by the aweme id, EXACTLY like IG: the enrichment carries the raw URL (so
// presence/absence drives the "has a cover?" branch), the surface rewrites it to
// /api/tiktok/thumbnail/<awemeId>.
//
// Metrics-by-presence (D-05): a NULL snapshot column stays NULL on the dto (a
// photo-mode post has no views → null, NOT 0). The shareCount is also independently
// nullable (a photo-mode post with no shares → null).
//
// NO denormalization of the TikTok @handle / display name here (AGENTS.md). The
// handle / account display name lives on data_sources / tiktok_accounts; the card
// reads it from the `source` prop at render time. This reader carries account_id
// (the intrinsic TikTok user id, URL-identity-safe) but never a renameable display
// value.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export interface TikTokEnrichment {
  /** Latest view / like / comment / SHARE from the most-recent
   *  tiktok_post_snapshots row. NULL when no snapshot exists yet. Each metric is
   *  INDEPENDENTLY nullable: metrics-by-presence (D-05) — viewCount/shareCount are
   *  null for photo-mode posts that don't surface them, NEVER coerced to 0.
   *  shareCount is the PLAT-02 delta TikTok carries that IG never did. */
  stats: {
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    shareCount: number | null;
    polledAt: Date;
  } | null;
  /** The fresh TikTok CDN thumbnail URL (signed + expiring) from
   *  tiktok_posts.thumbnail_url (the normalizer prefers dynamic_cover .awebp). The
   *  RAW CDN URL — 10-SPIKE.md Q3 RESOLVED at Plan 05 UAT: the cover is hotlink-
   *  BLOCKED in a real browser (net::ERR_BLOCKED_BY_ORB), so the card/chart seam
   *  rewrites this to the same-origin proxy /api/tiktok/thumbnail/<awemeId>
   *  (keyed by the aweme id, mirroring IG's #69). NULL until the post is
   *  resolved. */
  thumbnailUrl: string | null;
  /** Content form from tiktok_posts.media_type ("video" | "carousel", D-03).
   *  Drives the per-form card affordance. NULL until resolved. */
  mediaType: string | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper (Plan 05)
 *  reads the same key via the same cast shape. */
type TikTokDecorated = EventDto & { tiktokEnrichment?: TikTokEnrichment };

export async function tiktokEnrichFeedDtos(
  /** userId required by the SourceAdapter.enrichFeedDtos contract; unused here
   *  because both TikTok tables are PUBLIC-DATA. Tenant scope comes from the
   *  upstream events SELECT in mapEventsToDtos. */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const tkDtos = dtos.filter((d) => d.kind === "tiktok_post" && d.externalId !== null);
  if (tkDtos.length === 0) return;
  const externalIds = tkDtos.map((d) => d.externalId as string);

  try {
    // 1. Latest snapshot per aweme_id. tiktok_post_snapshots is an immutable time
    //    series — a tracked post accrues one row per poll. DISTINCT ON keeps the
    //    scan tight: exactly one row per aweme_id, the most recent. share_count is
    //    the PLAT-02 column IG never had.
    const idsSql = sql.join(
      externalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    // Queries 1 + 2 are independent (both key on externalIds) — run them
    // concurrently. Query 3 (operator-paused) depends on accountIds derived from
    // query 2's rows, so it stays sequential after this pair.
    const [latestRows, postRows] = await Promise.all([
      db.execute<{
        aweme_id: string;
        polled_at: Date;
        view_count: number | null;
        like_count: number | null;
        comment_count: number | null;
        share_count: number | null;
      }>(sql`
        SELECT DISTINCT ON (aweme_id)
          aweme_id, polled_at, view_count, like_count, comment_count, share_count
        FROM tiktok_post_snapshots
        WHERE aweme_id IN (${idsSql})
        ORDER BY aweme_id, polled_at DESC
      `),
      // 2. Thumbnail + media_type + account_id from tiktok_posts (post-keyed
      //    public-data). NO account display name read here (no-denorm rule).
      db
        .select({
          awemeId: tiktokPosts.awemeId,
          thumbnailUrl: tiktokPosts.thumbnailUrl,
          mediaType: tiktokPosts.mediaType,
          accountId: tiktokPosts.accountId,
        })
        .from(tiktokPosts)
        .where(inArray(tiktokPosts.awemeId, externalIds)),
    ]);
    const latest = new Map<string, TikTokEnrichment["stats"]>();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — bigint columns come back as
      // strings; Number() coerces a present value, null STAYS null
      // (metrics-by-presence D-05).
      latest.set(s.aweme_id, {
        viewCount: s.view_count === null ? null : Number(s.view_count),
        likeCount: s.like_count === null ? null : Number(s.like_count),
        commentCount: s.comment_count === null ? null : Number(s.comment_count),
        // PLAT-02: the share metric, presence-mapped (null for a photo-mode post
        // with no shares; never coerced to 0).
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
      postMeta.set(r.awemeId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaType: r.mediaType,
        accountId: r.accountId,
      });
    }

    // 3. Operator-budget-paused accounts (BUDGET-01). The walker flips
    //    metadata.tiktok.operatorPaused on the per-account channel-state row when a
    //    poll/backfill tick is paused by the operator's prepaid budget, and clears
    //    it on a successful unpaused tick. We overlay it onto each event's
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
            eq(dataSourceChannelState.kind, "tiktok_account"),
            inArray(dataSourceChannelState.channelKey, accountIds),
          ),
        );
      for (const r of stateRows) {
        const tk = (r.metadata as { tiktok?: { operatorPaused?: unknown } } | null)?.tiktok;
        if (tk?.operatorPaused === true) pausedAccounts.add(r.channelKey);
      }
    }

    // In-place decoration. Attach tiktokEnrichment to each filtered dto; the
    // card-props mapper (Plan 05) reads the same shape. The operator-paused hint is
    // merged into the DTO's metadata (NOT the decoration) because the PollingBadge
    // reads event.metadata.operator_paused.
    for (const dto of tkDtos) {
      const eid = dto.externalId as string;
      const meta = postMeta.get(eid) ?? null;
      (dto as TikTokDecorated).tiktokEnrichment = {
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
      { err: String((err as Error)?.message ?? err), count: tkDtos.length },
      "tiktok.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}

// Telegram feed-enrichment hook (VIZ-05 feed surface).
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos iterator
// (cross-source contract). Mutates EventDto rows in place for
// kind='telegram_post' entries; ignores other kinds — callers do NOT
// pre-filter, internal filtering is the contract (mirrors
// youtube/reddit/instagram enrichFeedDtos).
//
// Two batched lookups, both PUBLIC-DATA / channel-global (no userId scope —
// allowlisted in Plan 01; the tenant guarantee comes from the events SELECT in
// mapEventsToDtos):
//   1. telegram_post_snapshots — DISTINCT ON (post_id) latest view_count +
//      polled_at. Raw SQL because Drizzle's pg-core builder has no first-class
//      DISTINCT ON helper (same as youtube/instagram enrichFeedDtos).
//   2. telegram_posts — per-post thumbnail_url + media_kind (D-06 hotlink
//      refreshed each poll).
//
// STRIPPED vs Instagram: NO data_source_channel_state operator-paused / budget
// overlay. Telegram is a FREE source — there is no operator prepaid budget to
// exhaust, so there is no "Paused · operator budget reached" PollingBadge
// variant to light up. (The IG enricher reads the channel-state row to overlay
// metadata.operator_paused; Telegram has no such state.)
//
// Metrics-by-presence (D-05): a NULL snapshot view_count stays NULL on the dto
// (very new / views-hidden post → null, NOT 0). The UI renders the metric only
// when non-null. This is why the decoration's viewCount field is
// `number | null`.
//
// NO denormalization of the channel @-handle / display name here (AGENTS.md
// no-denorm rule). The channel title / handle lives on data_sources (the
// source-of-truth row); the Telegram feed card reads it from the `source` prop
// at render time (exactly as the YouTube / Reddit / IG cards read their
// data_sources display value) so a channel rename reflects everywhere without a
// per-post re-walk. This reader only touches post-keyed public-data.
//
// Decoration shape (attached via cast — EventDto stays unchanged, mirroring the
// Reddit redditEnrichment / IG instagramEnrichment pattern): we hang a
// `telegramEnrichment` property on the dto object. The UI mapper (Plan 05/06
// ui/card-props.ts) reads via the same cast shape; no schema changes to EventDto.
//
// Errors are swallowed at WARN — a failed enrichment query MUST NOT break the
// /feed render. The card falls back to a stats-less view.

import { inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";
import type { TelegramReaction } from "./schema/posts.js";

export interface TelegramEnrichment {
  /** Latest view count + reaction total + poll time from the most-recent
   *  telegram_post_snapshots row. NULL when no snapshot exists yet (worker
   *  hasn't polled, or every poll had views hidden). Each count is
   *  INDEPENDENTLY nullable: metrics-by-presence (D-05) — null for a
   *  views-hidden / no-reactions / very-new post, NEVER coerced to 0. */
  stats: {
    viewCount: number | null;
    reactionsTotal: number | null;
    polledAt: Date;
  } | null;
  /** Top-5 most-popular reactions (E1) from telegram_posts.reactions_top
   *  (current-state, parallels thumbnailUrl). null until first resolved; []
   *  for a resolved post with no reactions. The card renders a per-kind glyph
   *  (emoji char for standard, a stars glyph for paid, a generic glyph for
   *  custom) + count for each entry, or NO reactions row when null/empty. */
  reactionsTop: TelegramReaction[] | null;
  /** The fresh t.me hotlink thumbnail (D-06) from telegram_posts.thumbnail_url.
   *  Refreshed every poll by the snapshot writer. NULL until the post is
   *  resolved or for a text-only post. */
  thumbnailUrl: string | null;
  /** Content form from telegram_posts.media_kind ("photo" | "video" | "album").
   *  Drives the per-form card affordance. NULL for a text-only post / until
   *  resolved. */
  mediaKind: string | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper
 *  (Plan 05/06) reads the same key via the same cast shape. */
type TelegramDecorated = EventDto & { telegramEnrichment?: TelegramEnrichment };

export async function telegramEnrichFeedDtos(
  /** userId required by the SourceAdapter.enrichFeedDtos contract; unused here
   *  because both Telegram tables are PUBLIC-DATA. Tenant scope comes from the
   *  upstream events SELECT in mapEventsToDtos. */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const tgDtos = dtos.filter((d) => d.kind === "telegram_post" && d.externalId !== null);
  if (tgDtos.length === 0) return;
  const externalIds = tgDtos.map((d) => d.externalId as string);

  try {
    // 1. Latest snapshot per post_id. telegram_post_snapshots is an immutable
    //    time series — a tracked post accrues one row per poll. DISTINCT ON
    //    (post_id) ORDER BY post_id, polled_at DESC keeps the scan tight:
    //    exactly one row per requested post_id, the most recent. Raw SQL
    //    because Drizzle's pg-core builder has no DISTINCT ON helper.
    const idsSql = sql.join(
      externalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const latestRows = await db.execute<{
      post_id: string;
      polled_at: Date;
      view_count: number | null;
      reactions_total: number | null;
    }>(sql`
      SELECT DISTINCT ON (post_id)
        post_id, polled_at, view_count, reactions_total
      FROM telegram_post_snapshots
      WHERE post_id IN (${idsSql})
      ORDER BY post_id, polled_at DESC
    `);
    const latest = new Map<string, TelegramEnrichment["stats"]>();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — bigint columns come back as
      // strings; Number() coerces a present value, null STAYS null
      // (metrics-by-presence D-05: a views-hidden / no-reactions post's count is
      // null, never 0).
      latest.set(s.post_id, {
        viewCount: s.view_count === null ? null : Number(s.view_count),
        reactionsTotal: s.reactions_total === null ? null : Number(s.reactions_total),
        polledAt:
          s.polled_at instanceof Date ? s.polled_at : new Date(s.polled_at as unknown as string),
      });
    }

    // 2. Thumbnail + media_kind + reactions_top from telegram_posts (post-keyed
    //    public-data). NO channel display name read here — the @-handle lives on
    //    data_sources and the card reads it from the `source` prop (no-denorm).
    const postRows = await db
      .select({
        postId: telegramPosts.postId,
        thumbnailUrl: telegramPosts.thumbnailUrl,
        mediaKind: telegramPosts.mediaKind,
        reactionsTop: telegramPosts.reactionsTop,
      })
      .from(telegramPosts)
      .where(inArray(telegramPosts.postId, externalIds));
    const postMeta = new Map<
      string,
      {
        thumbnailUrl: string | null;
        mediaKind: string | null;
        reactionsTop: TelegramReaction[] | null;
      }
    >();
    for (const r of postRows) {
      postMeta.set(r.postId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaKind: r.mediaKind,
        reactionsTop: r.reactionsTop ?? null,
      });
    }

    // In-place decoration. Iterate the filtered subset and attach
    // telegramEnrichment to each; the card-props mapper (Plan 05/06) reads the
    // same shape.
    for (const dto of tgDtos) {
      const eid = dto.externalId as string;
      const meta = postMeta.get(eid) ?? null;
      (dto as TelegramDecorated).telegramEnrichment = {
        stats: latest.get(eid) ?? null,
        thumbnailUrl: meta?.thumbnailUrl ?? null,
        mediaKind: meta?.mediaKind ?? null,
        reactionsTop: meta?.reactionsTop ?? null,
      };
    }
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: tgDtos.length },
      "telegram.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}

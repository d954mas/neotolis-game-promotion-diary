// Reddit feed-enrichment hook (VIZ-05 feed surface) — clone of twitter/server/
// feed-enrichment.ts, trimmed to the D-09 like/comment metric set + the Reddit
// thumbnail hotlink decision.
//
// Called by the /feed loader via the allAdapters[*].enrichFeedDtos iterator.
// Mutates EventDto rows in place for kind='reddit_post' entries; ignores other
// kinds — callers do NOT pre-filter (internal filtering is the contract).
//
// Three batched lookups, all PUBLIC-DATA / channel-global (no userId scope; the
// tenant guarantee comes from the events SELECT in mapEventsToDtos):
//   1. reddit_post_snapshots — DISTINCT ON (post_id) latest like / comment counts
//      (raw SQL; Drizzle has no DISTINCT ON helper). D-09: no view/share columns.
//   2. reddit_posts — per-post thumbnail_url + media_type + subreddit_slug.
//   3. data_source_channel_state — the per-source operator-budget-paused hint. The
//      walker flips metadata.reddit.operatorPaused on the source's channel-state row
//      (source of truth); we overlay it onto each event's metadata.operator_paused
//      so the PollingBadge renders the paused variant. Resolved via the EVENT'S OWN
//      source (dto.sourceId → data_sources.kind/channel_id → channel state), never
//      via the post's author/subreddit: a post's author may be tracked by an
//      UNRELATED paused account source, which must not light this event's badge.
//
// THUMBNAIL (D-06, hotlink-first, NO proxy per Pitfall 5 YAGNI): thumbnail_url is
// the raw Reddit CDN URL (i.redd.it). It is FREQUENTLY NULL — ScrapeCreators omits
// the `thumbnail` field, so the normalizer derives it by presence (image posts →
// url, else null). The card must render no image chip when null. The value, when
// present, is hotlinked directly with an onerror fallback (image/gallery variant
// un-sampled by the spike — confirmed at Plan 12-06 UAT).
//
// Metrics-by-presence: a NULL snapshot column stays NULL on the dto (never 0).
//
// NO denormalization of the subreddit/account DISPLAY name here (AGENTS.md). The
// renameable title lives on reddit_subreddits / reddit_accounts / data_sources; the
// card reads it from the `source` prop at render time. This reader carries
// subreddit_slug (the intrinsic URL-identity-safe slug) but never a renameable
// display value.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export interface RedditEnrichment {
  /** Latest like / comment from the most-recent reddit_post_snapshots row. NULL when
   *  no snapshot exists yet. Each metric is INDEPENDENTLY nullable
   *  (metrics-by-presence). D-09: NO view or share metric (Reddit exposes neither). */
  stats: {
    likeCount: number | null;
    commentCount: number | null;
    polledAt: Date;
  } | null;
  /** The raw Reddit CDN cover URL from reddit_posts.thumbnail_url (i.redd.it).
   *  HOTLINKED directly (D-06 — no proxy). FREQUENTLY NULL (ScrapeCreators omits the
   *  thumbnail field); the card renders no image chip when null. */
  thumbnailUrl: string | null;
  /** Reddit post FORM from reddit_posts.media_type ("self"|"link"|"image"|"gallery").
   *  Drives the per-form card affordance + the cross-source media-type filter. NULL
   *  until resolved. */
  mediaType: string | null;
  /** Outbound destination domain from reddit_posts.link_domain — LINK posts only,
   *  null for every other form. Intrinsic immutable post content (the link target
   *  cannot be edited on Reddit), NOT a renameable denorm. Domain only, never the
   *  full URL — the card renders it as muted text, no href surface. */
  linkDomain: string | null;
  /** ISO timestamp when the Variant-A walk / write-path belt first detected this post
   *  as deleted-on-Reddit (reddit_posts.deletion_detected_at), else null. The event
   *  detail surface (EventDetailContent) renders a "Deleted on Reddit" notice off this;
   *  without projecting it here that notice could never appear. */
  deletionDetectedAt: string | null;
  /** The post's own subreddit slug from reddit_posts.subreddit_slug. INTRINSIC, not a
   *  display name — Reddit forbids subreddit rename and the slug IS part of the
   *  canonical URL, so this is the one sanctioned denormalization (AGENTS.md). The card
   *  needs it because an ACCOUNT source's label is the handle: without this a dev
   *  tracking their own posts cannot see which community each one went to. */
  subredditSlug: string | null;
}

/** Discriminator key for the in-place decoration. The card-props mapper (Plan 06)
 *  reads the same key via the same cast shape. */
type RedditDecorated = EventDto & { redditEnrichment?: RedditEnrichment };

export async function redditEnrichFeedDtos(
  /** Scopes the operator-paused source lookup (data_sources is tenant-owned); the
   *  Reddit post/snapshot tables stay PUBLIC-DATA. Tenant scope for the dtos
   *  themselves comes from the upstream events SELECT in mapEventsToDtos. */
  userId: string,
  dtos: EventDto[],
): Promise<void> {
  // Internal filter — caller does NOT pre-filter.
  const rdDtos = dtos.filter((d) => d.kind === "reddit_post" && d.externalId !== null);
  if (rdDtos.length === 0) return;
  const externalIds = rdDtos.map((d) => d.externalId as string);

  try {
    // 1. Latest snapshot per post_id. reddit_post_snapshots is an immutable time
    //    series — a tracked post accrues one row per poll. DISTINCT ON keeps the scan
    //    tight: exactly one row per post_id, the most recent.
    const idsSql = sql.join(
      externalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    // Queries 1 + 2 key on externalIds, query 3a (the events' own sources) keys on
    // sourceIds — all independent, run them concurrently. Query 3b (channel state)
    // depends on 3a's kind/channelId pairs.
    const sourceIds = [
      ...new Set(rdDtos.map((d) => d.sourceId).filter((id): id is string => id !== null)),
    ];
    const [latestRows, postRows, sourceRows] = await Promise.all([
      db.execute<{
        post_id: string;
        polled_at: Date;
        like_count: number | null;
        comment_count: number | null;
      }>(sql`
        SELECT DISTINCT ON (post_id)
          post_id, polled_at, like_count, comment_count
        FROM reddit_post_snapshots
        WHERE post_id IN (${idsSql})
        ORDER BY post_id, polled_at DESC
      `),
      // 2. Thumbnail + media_type + subreddit_slug from reddit_posts (post-keyed
      //    public-data). NO subreddit/account display name read here (no-denorm rule).
      db
        .select({
          postId: redditPosts.postId,
          thumbnailUrl: redditPosts.thumbnailUrl,
          mediaType: redditPosts.mediaType,
          linkDomain: redditPosts.linkDomain,
          subredditSlug: redditPosts.subredditSlug,
          deletionDetectedAt: redditPosts.deletionDetectedAt,
        })
        .from(redditPosts)
        .where(inArray(redditPosts.postId, externalIds)),
      // 3a. The events' OWN sources (tenant-scoped) — kind + channel_id resolve the
      //     operator-paused channel-state row for exactly this event's source.
      sourceIds.length === 0
        ? Promise.resolve([])
        : db
            .select({
              id: dataSources.id,
              kind: dataSources.kind,
              channelId: dataSources.channelId,
            })
            .from(dataSources)
            .where(
              and(
                eq(dataSources.userId, userId),
                inArray(dataSources.id, sourceIds),
                inArray(dataSources.kind, ["reddit_account", "reddit_subreddit"]),
                isNull(dataSources.deletedAt),
              ),
            ),
    ]);
    const latest = new Map<string, RedditEnrichment["stats"]>();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — bigint columns come back as
      // strings; Number() coerces a present value, null STAYS null
      // (metrics-by-presence).
      latest.set(s.post_id, {
        likeCount: s.like_count === null ? null : Number(s.like_count),
        commentCount: s.comment_count === null ? null : Number(s.comment_count),
        polledAt:
          s.polled_at instanceof Date ? s.polled_at : new Date(s.polled_at as unknown as string),
      });
    }

    const postMeta = new Map<
      string,
      {
        thumbnailUrl: string | null;
        mediaType: string | null;
        linkDomain: string | null;
        subredditSlug: string | null;
        deletionDetectedAt: Date | null;
      }
    >();
    for (const r of postRows) {
      postMeta.set(r.postId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaType: r.mediaType,
        linkDomain: r.linkDomain,
        subredditSlug: r.subredditSlug,
        deletionDetectedAt: r.deletionDetectedAt,
      });
    }

    // 3b. Operator-budget-paused overlay, resolved through the event's OWN source
    //     (review fix). The walker flips metadata.reddit.operatorPaused on the
    //     (kind, channelKey) channel-state row when a poll/backfill tick is paused by
    //     the operator's prepaid budget, and clears it on a successful unpaused tick.
    //     Each event inherits ONLY its own source's state: matching by the post's
    //     author/subreddit instead lit the badge whenever ANY channel sharing the post
    //     (e.g. an unrelated paused account source tracking the same author) was
    //     paused. The `${kind}:${channelKey}` namespacing stays — r/gamedev and
    //     u/gamedev are the same string in different keyspaces. A source-less pasted
    //     event has no pollable source, so it never renders the paused variant.
    const pausedSourceIds = new Set<string>();
    if (sourceRows.length > 0) {
      const channelKeys = [
        ...new Set(sourceRows.map((r) => r.channelId).filter((k): k is string => k !== null)),
      ];
      const stateRows = await db
        .select({
          kind: dataSourceChannelState.kind,
          channelKey: dataSourceChannelState.channelKey,
          metadata: dataSourceChannelState.metadata,
        })
        .from(dataSourceChannelState)
        .where(
          and(
            inArray(dataSourceChannelState.kind, ["reddit_account", "reddit_subreddit"]),
            inArray(dataSourceChannelState.channelKey, channelKeys),
          ),
        );
      const pausedChannels = new Set<string>();
      for (const r of stateRows) {
        const rd = (r.metadata as { reddit?: { operatorPaused?: unknown } } | null)?.reddit;
        if (rd?.operatorPaused === true) pausedChannels.add(`${r.kind}:${r.channelKey}`);
      }
      for (const s of sourceRows) {
        if (s.channelId !== null && pausedChannels.has(`${s.kind}:${s.channelId}`)) {
          pausedSourceIds.add(s.id);
        }
      }
    }

    // In-place decoration. Attach redditEnrichment to each filtered dto; the
    // card-props mapper (Plan 06) reads the same shape. The operator-paused hint is
    // merged into the DTO's metadata (NOT the decoration) because the PollingBadge
    // reads event.metadata.operator_paused.
    for (const dto of rdDtos) {
      const eid = dto.externalId as string;
      const meta = postMeta.get(eid) ?? null;
      (dto as RedditDecorated).redditEnrichment = {
        stats: latest.get(eid) ?? null,
        thumbnailUrl: meta?.thumbnailUrl ?? null,
        mediaType: meta?.mediaType ?? null,
        linkDomain: meta?.linkDomain ?? null,
        deletionDetectedAt: meta?.deletionDetectedAt ? meta.deletionDetectedAt.toISOString() : null,
        subredditSlug: meta?.subredditSlug ?? null,
      };
      // Paused iff the EVENT'S OWN source's channel is operator-paused (3b above).
      const isPaused = dto.sourceId !== null && pausedSourceIds.has(dto.sourceId);
      if (isPaused) {
        const base =
          dto.metadata !== null && typeof dto.metadata === "object"
            ? (dto.metadata as Record<string, unknown>)
            : {};
        dto.metadata = { ...base, operator_paused: true };
      }
    }
  } catch (err) {
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: rdDtos.length },
      "reddit.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}

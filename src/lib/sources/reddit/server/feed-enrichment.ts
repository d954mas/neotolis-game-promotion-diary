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
//      so the PollingBadge renders the paused variant.
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

import { and, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
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
  /** userId required by the SourceAdapter.enrichFeedDtos contract; unused here
   *  because both Reddit tables are PUBLIC-DATA. Tenant scope comes from the upstream
   *  events SELECT in mapEventsToDtos. */
  _userId: string,
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
    // Queries 1 + 2 are independent (both key on externalIds) — run them
    // concurrently. Query 3 (operator-paused) depends on subredditSlugs from query 2.
    const [latestRows, postRows] = await Promise.all([
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
          subredditSlug: redditPosts.subredditSlug,
          author: redditPosts.author,
          deletionDetectedAt: redditPosts.deletionDetectedAt,
        })
        .from(redditPosts)
        .where(inArray(redditPosts.postId, externalIds)),
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
        subredditSlug: string | null;
        author: string | null;
        deletionDetectedAt: Date | null;
      }
    >();
    for (const r of postRows) {
      postMeta.set(r.postId, {
        thumbnailUrl: r.thumbnailUrl,
        mediaType: r.mediaType,
        subredditSlug: r.subredditSlug,
        author: r.author,
        deletionDetectedAt: r.deletionDetectedAt,
      });
    }

    // 3. Operator-budget-paused sources. The walker flips metadata.reddit.
    //    operatorPaused on the per-source channel-state row when a poll/backfill tick
    //    is paused by the operator's prepaid budget, and clears it on a successful
    //    unpaused tick. We overlay it onto each event's metadata.operator_paused so
    //    the PollingBadge lights up. NO per-event denormalization: one channel-state
    //    row drives every event of the source. Keyed on the subreddit_slug channelKey
    //    (reddit_subreddit sources) OR the LOWERCASE username channelKey (reddit_account
    //    sources — reddit_posts.author is stored verbatim, so lowercase it to match the
    //    channel-state key). Both are gathered so a paused account source lights too.
    const channelKeys = [
      ...new Set(
        postRows
          .flatMap((r) => [r.subredditSlug, r.author === null ? null : r.author.toLowerCase()])
          .filter((k): k is string => k !== null && k !== ""),
      ),
    ];
    // Namespaced `${kind}:${channelKey}` — a subreddit slug and an account username
    // can be the SAME string (r/gamedev vs u/gamedev), so a flat key set would let a
    // paused account spuriously light the paused badge on an unrelated subreddit's posts.
    const pausedKeys = new Set<string>();
    if (channelKeys.length > 0) {
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
      for (const r of stateRows) {
        const rd = (r.metadata as { reddit?: { operatorPaused?: unknown } } | null)?.reddit;
        if (rd?.operatorPaused === true) pausedKeys.add(`${r.kind}:${r.channelKey}`);
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
        deletionDetectedAt: meta?.deletionDetectedAt ? meta.deletionDetectedAt.toISOString() : null,
        subredditSlug: meta?.subredditSlug ?? null,
      };
      // A post is paused if EITHER its subreddit source OR its account source is paused.
      // Match on the kind-namespaced key so the two keyspaces can't collide.
      const isPaused =
        (meta?.subredditSlug != null && pausedKeys.has(`reddit_subreddit:${meta.subredditSlug}`)) ||
        (meta?.author != null && pausedKeys.has(`reddit_account:${meta.author.toLowerCase()}`));
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

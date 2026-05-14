// Reddit sub_poll handler — fetch /r/<sub>/new.json?limit=100 and
// (opportunistically) /r/<sub>/about.json once per day per sub.
//
// Triggered by:
//   - service_source cron daily picks (plan 05B fills the queue 4×/day
//     for every registered reddit_subreddit data_source).
//   - user_source — user "refresh source" click on a registered sub.
//
// Side effects:
//   1. UPSERT reddit_subreddits_cache (PK name) — opportunistic about.json
//      refresh writes subscribers/description/submission_metadata when
//      last_metadata_refresh_at is older than 24h.
//   2. UPSERT reddit_posts for each t3 child (up to 100).
//   3. writeRedditPostSnapshot per t3 (V20 idempotent).
//   4. UPSERT reddit_users_cache for each unique author.
//   5. writeRedditSubredditSnapshot (subscribers / accounts_active) when
//      we did fetch about.json this tick.
//   6. Fan-out: for every data_sources row with kind='reddit_subreddit'
//      AND metadata->>'subreddit'=<sub> AND auto_import=true AND
//      deleted_at IS NULL, INSERT one events row per (post × subscriber)
//      that isn't already present (idempotency via
//      events_user_kind_source_ext_unq partial index +
//      onConflictDoNothing).
//
// Cross-tenant by design — the fan-out walks subscribers across users
// for the same subreddit. Tenant scoping enforced at INSERT (each
// subscriber's user_id is independent) and at audit (no audit row
// emitted per fan-out — cron flow is operator-pool accounted via
// reddit.queue_drained at worker-tick level).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import { upsertRedditPost, upsertRedditUser, upsertRedditSubreddit } from "../upsert.js";
import {
  writeRedditPostSnapshot,
  writeRedditSubredditSnapshot,
} from "../snapshots.js";
import { redditSubredditsCache } from "../schema/index.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { AdapterError } from "$lib/sources/errors.js";
import { markSourceNeedsReconnect } from "$lib/server/services/data-sources.js";
import { logger } from "$lib/server/logger.js";
import { classifySnapshotStatus } from "./post-single.js";

interface T3Data {
  id: string;
  name: string;
  subreddit: string;
  subreddit_id?: string | null;
  author: string;
  author_fullname?: string;
  permalink: string;
  url?: string;
  title: string;
  selftext?: string;
  is_self?: boolean;
  created_utc: number;
  score?: number;
  num_comments?: number;
  upvote_ratio?: number;
  total_awards_received?: number;
  over_18?: boolean;
  spoiler?: boolean;
  stickied?: boolean;
  locked?: boolean;
  archived?: boolean;
  removed_by_category?: string | null;
  crosspost_parent?: string | null;
  link_flair_text?: string | null;
}

interface AboutData {
  display_name: string;
  id?: string;
  subscribers?: number;
  accounts_active?: number | null;
  description?: string | null;
  public_description?: string | null;
  over18?: boolean;
  subreddit_type?: string | null;
  submission_type?: string;
  allow_videos?: boolean;
  allow_galleries?: boolean;
}

/** Refresh the about.json once per 24h per sub. */
const ABOUT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function handleSubPoll(args: {
  sub: string;
  userId: string | null;
}): Promise<{ postsUpserted: number; eventsInserted: number }> {
  const sub = args.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new AdapterError("sub_poll: missing sub in payload", { category: "permanent" });
  }

  // 1. Fetch the listing. AdapterError categories bubble — worker tick
  //    catches and routes to status (pending → retry, dead_letter, etc.).
  let listingChildren: T3Data[];
  try {
    const { data } = await redditFetch<{
      data?: { children?: Array<{ kind?: string; data?: T3Data }> };
    }>(`/r/${encodeURIComponent(sub)}/new.json?limit=100`);
    listingChildren = (data?.data?.children ?? [])
      .filter((c) => c?.kind === "t3" && c?.data)
      .map((c) => c.data as T3Data);
  } catch (err) {
    if (err instanceof AdapterError && err.category === "not-found") {
      await flagNotFoundOnSubscribers(sub, "not-found");
    }
    throw err;
  }

  // 2. Opportunistic about.json fetch — once per 24h per sub. Surface
  //    as a SECOND HTTP call within the same worker tick when due, but
  //    only one /new.json fetch per tick — the about budget folds into
  //    the same "slot" per D-RDT-SUB-SNAPSHOTS planner-discretion note.
  //    Failures are logged + swallowed: the new.json work already
  //    succeeded; about staleness can wait until the next tick.
  const aboutData = await maybeFetchAbout(sub);

  // 3. UPSERT the sub cache (also seeds the row before snapshot write).
  //    Always at least the (name) PK; about-data writes additional fields
  //    when fetched this tick.
  await upsertRedditSubreddit(db, {
    name: sub,
    subredditId: aboutData?.id ? `t5_${aboutData.id}` : null,
    subscribers: aboutData?.subscribers ?? null,
    accountsActive: aboutData?.accounts_active ?? null,
    description: aboutData?.description ?? null,
    publicDescription: aboutData?.public_description ?? null,
    submissionMetadata: aboutData
      ? {
          submission_type: aboutData.submission_type ?? null,
          allow_videos: aboutData.allow_videos ?? null,
          allow_galleries: aboutData.allow_galleries ?? null,
        }
      : undefined,
    over18: aboutData?.over18 ?? false,
    subredditType: aboutData?.subreddit_type ?? null,
  });

  // 4. If we fetched about.json this tick, also write the daily snapshot
  //    for the growth-rate time-series.
  if (aboutData) {
    await writeRedditSubredditSnapshot(db, {
      subreddit: sub,
      subscribers: aboutData.subscribers ?? null,
      accountsActive: aboutData.accounts_active ?? null,
    });
  }

  // 5. UPSERT authors + posts + snapshots for each t3.
  const uniqueAuthors = new Set<string>();
  for (const t3 of listingChildren) {
    const author = t3.author === "[deleted]" ? null : t3.author;
    if (author !== null && !uniqueAuthors.has(author)) {
      uniqueAuthors.add(author);
      const authorFullname = t3.author_fullname ?? null;
      await upsertRedditUser(db, {
        username: author,
        redditId: authorFullname,
        accountAgeDays: null,
        linkKarma: null,
        commentKarma: null,
        totalKarma: null,
        isSuspended: false,
      });
    }
  }
  for (const t3 of listingChildren) {
    const author = t3.author === "[deleted]" ? null : t3.author;
    const authorFullname = author === null ? null : (t3.author_fullname ?? null);
    const fullId = `t3_${t3.id}`;
    const permalink = t3.permalink.startsWith("http")
      ? t3.permalink
      : `https://www.reddit.com${t3.permalink}`;
    const submittedAt = new Date(t3.created_utc * 1000);

    await upsertRedditPost(db, {
      postId: fullId,
      subreddit: t3.subreddit,
      author,
      authorFullname,
      permalink,
      title: t3.title,
      submittedAt,
      metadata: buildPostMetadata(t3),
    });
    await writeRedditPostSnapshot(db, {
      postId: fullId,
      score: t3.score ?? null,
      numComments: t3.num_comments ?? null,
      awardsTotal: t3.total_awards_received ?? null,
      upvoteRatio: t3.upvote_ratio ?? null,
      removedByCategory: t3.removed_by_category ?? null,
      status: classifySnapshotStatus(t3),
    });
  }

  // 6. Fan-out events INSERT for auto_import=true subscribers.
  const eventsInserted = await fanOutToSubscribers(sub, listingChildren);

  logger.info(
    {
      sub,
      userId: args.userId,
      postsFetched: listingChildren.length,
      eventsInserted,
      aboutFetched: aboutData !== null,
    },
    "reddit sub_poll: complete",
  );

  return { postsUpserted: listingChildren.length, eventsInserted };
}

/** Decide whether to fetch /r/<sub>/about.json this tick. Costs +1 HTTP
 *  call (same worker slot, sequential after /new.json — accepted under
 *  D-RDT-CACHE-POPULATION's "we batch-pipeline 2 sequential calls per
 *  tick when needed" guidance). Returns null when the cache row is
 *  fresh (<24h) or the fetch fails. */
async function maybeFetchAbout(sub: string): Promise<AboutData | null> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- public-data cache (sub metadata)
  const rows = await db
    .select({ lastRefresh: redditSubredditsCache.lastMetadataRefreshAt })
    .from(redditSubredditsCache)
    .where(eq(redditSubredditsCache.name, sub))
    .limit(1);
  const lastRefresh = rows[0]?.lastRefresh ?? null;
  if (lastRefresh !== null) {
    const age = Date.now() - new Date(lastRefresh).getTime();
    if (age < ABOUT_REFRESH_INTERVAL_MS) return null;
  }
  try {
    const { data } = await redditFetch<{ data?: AboutData }>(
      `/r/${encodeURIComponent(sub)}/about.json`,
    );
    return data?.data ?? null;
  } catch (err) {
    // about.json failure must not block the main /new.json path.
    logger.warn(
      { sub, err: String((err as Error)?.message ?? err) },
      "reddit sub_poll: about.json fetch failed; new.json result still landed",
    );
    return null;
  }
}

/** INSERT events rows for every auto_import=true subscriber × every
 *  not-yet-present post. Returns total rows inserted across subscribers. */
async function fanOutToSubscribers(sub: string, t3s: T3Data[]): Promise<number> {
  if (t3s.length === 0) return 0;
  // CROSS-TENANT BY DESIGN — sub_poll fans out across all subscribers.
  // Tenant scope at the row level: each event INSERT carries its own
  // subscriber's user_id; the partial UNIQUE
  // (user_id, kind, source_id, external_id) protects per-user dedup.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, "reddit_subreddit"),
        eq(dataSources.autoImport, true),
        sql`${dataSources.metadata}->>'subreddit' = ${sub}`,
        isNull(dataSources.deletedAt),
      ),
    );
  if (subscribers.length === 0) return 0;

  // Pre-fetch idempotency map.
  const externalIds = t3s.map((t3) => `t3_${t3.id}`);
  const userIds = subscribers.map((s) => s.userId);
  const sourceIds = subscribers.map((s) => s.id);
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- fan-out idempotency (multiple user_ids)
  const existingRows = await db
    .select({
      userId: events.userId,
      sourceId: events.sourceId,
      externalId: events.externalId,
    })
    .from(events)
    .where(
      and(
        inArray(events.userId, userIds),
        inArray(events.sourceId, sourceIds),
        inArray(events.externalId, externalIds),
        eq(events.kind, "reddit_post"),
        isNull(events.deletedAt),
      ),
    );
  const existingSet = new Set(
    existingRows.map((r) => `${r.userId}|${r.sourceId}|${r.externalId}`),
  );

  let inserted = 0;
  for (const t3 of t3s) {
    const fullId = `t3_${t3.id}`;
    const author = t3.author === "[deleted]" ? null : t3.author;
    const submittedAt = new Date(t3.created_utc * 1000);
    const permalink = t3.permalink.startsWith("http")
      ? t3.permalink
      : `https://www.reddit.com${t3.permalink}`;

    for (const sub_row of subscribers) {
      const key = `${sub_row.userId}|${sub_row.id}|${fullId}`;
      if (existingSet.has(key)) continue;

      // authorIsMe: subscriber owns this sub-source (is_owned_by_me=true,
      // i.e. they ARE a poster in this sub) AND the post author matches
      // the subscriber's other registered reddit_account handle. The
      // simpler heuristic available here: inherit the subscriber's
      // is_owned_by_me flag. Stricter author-match (resolve to the
      // owning user's reddit_account handle) is handled by paste-flow's
      // findSourceByAuthorUrl already; sub_poll fan-out uses the source's
      // own is_owned_by_me bit.
      const authorIsMe = sub_row.isOwnedByMe && author !== null;

      const ins = await db
        .insert(events)
        .values({
          userId: sub_row.userId,
          sourceId: sub_row.id,
          kind: "reddit_post",
          authorIsMe,
          occurredAt: submittedAt,
          title: t3.title,
          url: permalink,
          externalId: fullId,
          metadata: {
            subreddit: t3.subreddit,
            author,
          },
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (ins.length > 0) inserted++;
    }
  }
  return inserted;
}

/** When a sub returns 404 / private, flag every auto_import subscriber's
 *  source row so the user sees the reconnect signal in UI. */
async function flagNotFoundOnSubscribers(sub: string, errorKind: "not-found"): Promise<void> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select({ userId: dataSources.userId, id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, "reddit_subreddit"),
        sql`${dataSources.metadata}->>'subreddit' = ${sub}`,
        isNull(dataSources.deletedAt),
      ),
    );
  for (const s of subscribers) {
    try {
      await markSourceNeedsReconnect(s.userId, s.id, errorKind);
    } catch (err) {
      logger.warn(
        { userId: s.userId, sourceId: s.id, err: String((err as Error)?.message ?? err) },
        "reddit sub_poll: markSourceNeedsReconnect failed",
      );
    }
  }
}

/** Subset of t3 fields persisted into reddit_posts.metadata. */
function buildPostMetadata(t3: T3Data): Record<string, unknown> {
  return {
    is_self: t3.is_self ?? false,
    link_url: t3.url ?? null,
    body_excerpt:
      typeof t3.selftext === "string" && t3.selftext.length > 0
        ? t3.selftext.slice(0, 200)
        : null,
    over_18: t3.over_18 ?? false,
    spoiler: t3.spoiler ?? false,
    stickied: t3.stickied ?? false,
    locked: t3.locked ?? false,
    archived: t3.archived ?? false,
    link_flair_text: t3.link_flair_text ?? null,
    crosspost_parent_id: t3.crosspost_parent ?? null,
  };
}

// Reddit author_poll handler — fetch /user/<handle>/submitted.json?limit=100
// and (opportunistically) /user/<handle>/about.json for OWNED accounts.
//
// Triggered by:
//   - service_source cron daily picks (plan 05B) for every registered
//     reddit_account data_source.
//   - user_source — user "refresh source" click on a registered account.
//
// Symmetric to sub_poll but for the /user/X listing surface. Differences:
//   - Endpoint shapes: /user/<handle>/submitted.json + /user/<handle>/about.json
//   - User-snapshots: when the about.json fetch succeeds and at least one
//     data_source for this handle has is_owned_by_me=true (i.e. the user
//     owns this account), write writeRedditUserSnapshot for the karma
//     time-series (D-RDT-USER-SNAPSHOTS — owned accounts only).
//   - Fan-out filter: kind='reddit_account' AND metadata->>'username'=<handle>
//
// Suspended-account handling: /user/<suspended>/about.json returns 200 OK
// with data: { is_suspended: true, ... } (truncated profile). The submitted
// listing may return 200+empty children OR 404 (RESEARCH §Probe 5). We
// upsert isSuspended=true on the cache row and let the empty children
// path proceed normally (no fan-out work).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { redditFetch } from "../http.js";
import { upsertRedditPost, upsertRedditUser, upsertRedditSubreddit } from "../upsert.js";
import { writeRedditPostSnapshot, writeRedditUserSnapshot } from "../snapshots.js";
import { buildPostMetadata } from "../post-metadata.js";
import { redditUsersCache } from "../schema/index.js";
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

interface UserAboutData {
  name: string;
  id?: string;
  link_karma?: number;
  comment_karma?: number;
  total_karma?: number;
  created_utc?: number;
  is_suspended?: boolean;
}

/** Daily refresh on user about. */
const ABOUT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function handleAuthorPoll(args: {
  handle: string;
  userId: string | null;
}): Promise<{ postsUpserted: number; eventsInserted: number }> {
  const handle = args.handle;
  if (typeof handle !== "string" || handle.length === 0) {
    throw new AdapterError("author_poll: missing handle in payload", { category: "permanent" });
  }

  // 1. /user/<handle>/submitted.json — listing fetch. 404 on deleted user.
  let listingChildren: T3Data[];
  try {
    const { data } = await redditFetch<{
      data?: { children?: Array<{ kind?: string; data?: T3Data }> };
    }>(`/user/${encodeURIComponent(handle)}/submitted.json?limit=100`);
    listingChildren = (data?.data?.children ?? [])
      .filter((c) => c?.kind === "t3" && c?.data)
      .map((c) => c.data as T3Data);
  } catch (err) {
    if (err instanceof AdapterError && err.category === "not-found") {
      await flagNotFoundOnSubscribers(handle, "not-found");
    }
    throw err;
  }

  // 2. Opportunistic /user/<handle>/about.json — once per day. Surfaces
  //    karma + is_suspended + account creation date.
  const aboutData = await maybeFetchUserAbout(handle);

  // 3. Are any of the registered sources for this handle owned-by-me?
  //    Drives writeRedditUserSnapshot (owned-only) AND the fan-out's
  //    authorIsMe assignment for the inserted events row.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, "reddit_account"),
        sql`${dataSources.metadata}->>'username' = ${handle}`,
        isNull(dataSources.deletedAt),
      ),
    );
  const ownedByAnySubscriber = subscribers.some((s) => s.isOwnedByMe);

  // 4. UPSERT the author cache row. about.json adds karma + suspended +
  //    account-age; without about, we just touch lastMetadataRefreshAt
  //    via the snapshot writes' UPSERT-equivalent.
  if (aboutData) {
    const accountAgeDays =
      typeof aboutData.created_utc === "number"
        ? Math.floor((Date.now() / 1000 - aboutData.created_utc) / (60 * 60 * 24))
        : null;
    await upsertRedditUser(db, {
      username: handle,
      redditId: aboutData.id ? `t2_${aboutData.id}` : null,
      accountAgeDays,
      linkKarma: aboutData.link_karma ?? null,
      commentKarma: aboutData.comment_karma ?? null,
      totalKarma: aboutData.total_karma ?? null,
      isSuspended: aboutData.is_suspended ?? false,
    });
    // OWNED user snapshot — D-RDT-USER-SNAPSHOTS narrows to owned only.
    if (ownedByAnySubscriber) {
      await writeRedditUserSnapshot(db, {
        username: handle,
        linkKarma: aboutData.link_karma ?? null,
        commentKarma: aboutData.comment_karma ?? null,
        totalKarma: aboutData.total_karma ?? null,
      });
    }
  } else {
    // Even without about.json, ensure a row exists (other code may JOIN
    // on the username PK).
    await upsertRedditUser(db, {
      username: handle,
      redditId: null,
      accountAgeDays: null,
      linkKarma: null,
      commentKarma: null,
      totalKarma: null,
      isSuspended: false,
    });
  }

  // 5. UPSERT subreddit caches for every unique sub in the listing —
  //    listing surfaces a user's posts across many subs; each needs at
  //    least the (name) PK to satisfy reddit_posts FK constraints.
  const uniqueSubs = new Set<string>();
  for (const t3 of listingChildren) {
    if (!uniqueSubs.has(t3.subreddit)) {
      uniqueSubs.add(t3.subreddit);
      await upsertRedditSubreddit(db, {
        name: t3.subreddit,
        subredditId: t3.subreddit_id ?? null,
        subscribers: null,
        accountsActive: null,
        description: null,
        publicDescription: null,
      });
    }
  }

  // 6. UPSERT posts + snapshots.
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

  // 7. Fan-out events INSERT to auto_import=true subscribers.
  const eventsInserted = await fanOutToSubscribers(handle, listingChildren, subscribers);

  logger.info(
    {
      handle,
      userId: args.userId,
      postsFetched: listingChildren.length,
      eventsInserted,
      aboutFetched: aboutData !== null,
      ownedByAnySubscriber,
    },
    "reddit author_poll: complete",
  );

  return { postsUpserted: listingChildren.length, eventsInserted };
}

async function maybeFetchUserAbout(handle: string): Promise<UserAboutData | null> {
  const rows = await db
    .select({ lastRefresh: redditUsersCache.lastMetadataRefreshAt })
    .from(redditUsersCache)
    .where(eq(redditUsersCache.username, handle))
    .limit(1);
  const lastRefresh = rows[0]?.lastRefresh ?? null;
  if (lastRefresh !== null) {
    const age = Date.now() - new Date(lastRefresh).getTime();
    if (age < ABOUT_REFRESH_INTERVAL_MS) return null;
  }
  try {
    const { data } = await redditFetch<{ data?: UserAboutData }>(
      `/user/${encodeURIComponent(handle)}/about.json`,
    );
    return data?.data ?? null;
  } catch (err) {
    // about.json failure must not block the main submitted.json path.
    logger.warn(
      { handle, err: String((err as Error)?.message ?? err) },
      "reddit author_poll: about.json fetch failed; submitted.json result still landed",
    );
    return null;
  }
}

async function fanOutToSubscribers(
  handle: string,
  t3s: T3Data[],
  subscribers: Array<typeof dataSources.$inferSelect>,
): Promise<number> {
  if (t3s.length === 0 || subscribers.length === 0) return 0;

  // Apply auto_import filter inline — we already have the subscriber list
  // from the owned-by-me probe above; reuse it.
  const autoImportSubs = subscribers.filter((s) => s.autoImport === true);
  if (autoImportSubs.length === 0) return 0;

  // inArray(events.userId, userIds) satisfies tenant-scope rule
  // structurally; the multi-tenant span is by design (channel-scoped fan-out).
  const externalIds = t3s.map((t3) => `t3_${t3.id}`);
  const userIds = autoImportSubs.map((s) => s.userId);
  const sourceIds = autoImportSubs.map((s) => s.id);
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
  const existingSet = new Set(existingRows.map((r) => `${r.userId}|${r.sourceId}|${r.externalId}`));

  let inserted = 0;
  for (const t3 of t3s) {
    const fullId = `t3_${t3.id}`;
    const author = t3.author === "[deleted]" ? null : t3.author;
    const submittedAt = new Date(t3.created_utc * 1000);
    const permalink = t3.permalink.startsWith("http")
      ? t3.permalink
      : `https://www.reddit.com${t3.permalink}`;

    for (const sub_row of autoImportSubs) {
      const key = `${sub_row.userId}|${sub_row.id}|${fullId}`;
      if (existingSet.has(key)) continue;

      const authorIsMe = sub_row.isOwnedByMe;

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
  // Silence unused-parameter lint (kept for parity with sub-poll and
  // future use — e.g. structured handle-specific audit metadata).
  void handle;
  return inserted;
}

async function flagNotFoundOnSubscribers(handle: string, errorKind: "not-found"): Promise<void> {
  // WHERE spans tenants by design (an external handle has no owning user).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out: external handle has no owning user
  const subscribers = await db
    .select({ userId: dataSources.userId, id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, "reddit_account"),
        sql`${dataSources.metadata}->>'username' = ${handle}`,
        isNull(dataSources.deletedAt),
      ),
    );
  for (const s of subscribers) {
    try {
      await markSourceNeedsReconnect(s.userId, s.id, errorKind);
    } catch (err) {
      logger.warn(
        { userId: s.userId, sourceId: s.id, err: String((err as Error)?.message ?? err) },
        "reddit author_poll: markSourceNeedsReconnect failed",
      );
    }
  }
}

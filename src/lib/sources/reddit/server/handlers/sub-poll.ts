// Reddit sub_poll handler — fetch /r/<sub>/new.json?limit=100.
//
// ONE Reddit HTTP request per tick by design. The global DB pacer
// (src/lib/sources/reddit/server/pacer.ts) advances `next_allowed_at`
// by REDDIT_PACER_SLOT_MS (7500ms) on every fetch; the worker tick
// interval is the same 7500ms — so a second redditFetch in the same
// tick is always denied. A previous version of this handler did
// `/new.json` followed by `/about.json` in the same call frame and
// silently swallowed the pacer denial, which left
// subscribers/accounts_active/description NULL forever. about-data
// refresh is deferred to a future per-sub queue type (see follow-up
// task in the phase tracker); the cache row still gets seeded with
// just `name` so reddit_posts FK constraints are satisfied.
//
// Triggered by:
//   - service_source cron daily picks (cron fills the queue 4×/day for
//     every registered reddit_subreddit data_source).
//   - user_source — user "refresh source" click on a registered sub.
//
// Side effects:
//   1. UPSERT reddit_subreddits_cache (PK name only — bare seed row).
//   2. UPSERT reddit_posts for each t3 child (up to 100).
//   3. writeRedditPostSnapshot per t3 (minute-truncated, idempotent).
//   4. UPSERT reddit_users_cache for each unique author.
//   5. Fan-out: for every data_sources row with kind='reddit_subreddit'
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
import { writeRedditPostSnapshot } from "../snapshots.js";
import { buildPostMetadata } from "../post-metadata.js";
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

export async function handleSubPoll(args: {
  sub: string;
  userId: string | null;
  pacer?: "acquire" | "already-acquired";
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
    }>(`/r/${encodeURIComponent(sub)}/new.json?limit=100`, { pacer: args.pacer });
    listingChildren = (data?.data?.children ?? [])
      .filter((c) => c?.kind === "t3" && c?.data)
      .map((c) => c.data as T3Data);
  } catch (err) {
    if (err instanceof AdapterError && err.category === "not-found") {
      await flagNotFoundOnSubscribers(sub, "not-found");
    }
    throw err;
  }

  // 2. UPSERT the sub cache with a bare seed row — name only. Richer
  //    fields (subscribers / description / submission_metadata) require
  //    /r/<sub>/about.json which can't share a worker tick with /new.json
  //    under the 7.5s pacer slot; that's a separate queue work item in a
  //    future phase.
  await upsertRedditSubreddit(db, {
    name: sub,
    subredditId: null,
    subscribers: null,
    accountsActive: null,
    description: null,
    publicDescription: null,
  });

  // 3. UPSERT authors + posts + snapshots for each t3.
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

  // 4. Fan-out events INSERT for auto_import=true subscribers.
  const eventsInserted = await fanOutToSubscribers(sub, listingChildren);

  logger.info(
    {
      sub,
      userId: args.userId,
      postsFetched: listingChildren.length,
      eventsInserted,
    },
    "reddit sub_poll: complete",
  );

  return { postsUpserted: listingChildren.length, eventsInserted };
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

  // Pre-fetch idempotency map. inArray(events.userId, userIds) satisfies
  // the tenant-scope rule (the where clause carries `userId`); the
  // multi-tenant span is by design (channel-scoped fan-out — see header).
  const externalIds = t3s.map((t3) => `t3_${t3.id}`);
  const userIds = subscribers.map((s) => s.userId);
  const sourceIds = subscribers.map((s) => s.id);
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

  // Per-subscriber owned-username map. authorIsMe for a sub_poll fan-out
  // row must require BOTH (a) the subscriber registered some Reddit
  // account as is_owned_by_me=true, and (b) the post's t3.author matches
  // that registered handle. Pre-fix: authorIsMe was `sub_row.isOwnedByMe
  // && author !== null` — but the subreddit source's is_owned_by_me bit
  // only claims "I post in this sub", not "I authored this specific
  // post". With /sources/new's default `defaultIsOwnedByMe: true` (line
  // 32 of +page.server.ts), every imported subreddit post would have been
  // marked authorIsMe=true regardless of who actually posted it.
  //
  // Lookup is scoped to the same userId set we already pin via the
  // events INSERT — no extra tenant span. One query for all subscribers
  // (avoids a per-row roundtrip in the hot fan-out loop).
  const ownedRedditAccounts = await db
    .select({
      userId: dataSources.userId,
      username: sql<string | null>`${dataSources.metadata}->>'username'`,
    })
    .from(dataSources)
    .where(
      and(
        inArray(dataSources.userId, userIds),
        eq(dataSources.kind, "reddit_account"),
        eq(dataSources.isOwnedByMe, true),
        isNull(dataSources.deletedAt),
      ),
    );
  const ownedHandlesByUser = new Map<string, Set<string>>();
  for (const r of ownedRedditAccounts) {
    if (r.username == null) continue;
    let set = ownedHandlesByUser.get(r.userId);
    if (!set) {
      set = new Set<string>();
      ownedHandlesByUser.set(r.userId, set);
    }
    set.add(r.username);
  }

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

      // Strict author-match — see ownedHandlesByUser computation above
      // for the rationale.
      const authorIsMe =
        author !== null && (ownedHandlesByUser.get(sub_row.userId)?.has(author) ?? false);

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
 *  source row so the user sees the reconnect signal in UI. WHERE spans
 *  tenants by design — an external sub doesn't have an owning user. */
async function flagNotFoundOnSubscribers(sub: string, errorKind: "not-found"): Promise<void> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out: external sub has no owning user
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

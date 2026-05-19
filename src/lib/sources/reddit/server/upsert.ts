// Reddit cache-table UPSERT helpers.
//
// Three idempotent writers for the three lazy-populated public-data
// caches:
//   - upsertRedditPost      — reddit_posts            (PK post_id)
//   - upsertRedditUser      — reddit_users_cache      (PK username)
//   - upsertRedditSubreddit — reddit_subreddits_cache (PK name)
//
// Each helper has a singular form (one row per call) used by paste-flow
// + per-row sub_poll/author_poll loops, AND a Many variant that takes
// an array and runs ONE multi-row INSERT. The Many variants are the
// load-bearing optimization for post_batch: a 100-id batch would
// otherwise do ~500 sequential DB round-trips; batched, it's 4 INSERTs.
//
// ON CONFLICT DO UPDATE refreshes volatile fields (title, metadata,
// karma, subscribers); the deletion-propagation guard means the
// post-row SET clause never touches author / author_fullname — once
// the nightly purge cron nulls those, a re-poll of a still-deleted
// post must not restore them.
//
// Case normalization: subreddit / username / author columns are written
// LOWERCASE. Reddit treats these identifiers as case-insensitive, so the
// canonical cache key is lowercase — and the upstream parser already
// normalizes its output. Reddit API responses (t3.subreddit / t3.author)
// can come back in display case, so the upsert helpers re-normalize at
// the write boundary as defense: any input that slips through with
// display case still lands on the canonical row.

import { sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { redditPosts, redditUsersCache, redditSubredditsCache } from "./schema/index.js";

export interface RedditPostUpsert {
  postId: string;
  subreddit: string;
  author: string | null;
  authorFullname: string | null;
  permalink: string;
  title: string;
  submittedAt: Date;
  metadata: Record<string, unknown>;
}

/** Upsert reddit_posts on (post_id). Refreshes title / permalink /
 *  metadata / last_snapshot_at on conflict. Does NOT overwrite author
 *  fields — preserves deletion-propagation purges. */
export async function upsertRedditPost(dbCtx: DbOrTx, args: RedditPostUpsert): Promise<void> {
  await upsertRedditPostsMany(dbCtx, [args]);
}

/** Multi-row variant. One INSERT … VALUES (…), (…) … ON CONFLICT DO
 *  UPDATE round-trip for the whole input. Returns the count of input
 *  rows (post-conflict landed rows may differ but the caller only
 *  needs to know the operation completed). */
export async function upsertRedditPostsMany(
  dbCtx: DbOrTx,
  rows: ReadonlyArray<RedditPostUpsert>,
): Promise<void> {
  if (rows.length === 0) return;
  await dbCtx
    .insert(redditPosts)
    .values(
      rows.map((r) => ({
        postId: r.postId,
        subreddit: r.subreddit.toLowerCase(),
        author: r.author === null ? null : r.author.toLowerCase(),
        authorFullname: r.authorFullname,
        permalink: r.permalink,
        title: r.title,
        submittedAt: r.submittedAt,
        metadata: r.metadata,
        lastSnapshotAt: sql`NOW()` as unknown as Date,
      })),
    )
    .onConflictDoUpdate({
      target: redditPosts.postId,
      set: {
        // Refresh volatile fields. Title rarely changes but Reddit
        // mods can edit; metadata may carry updated body_excerpt etc.
        // permalink can include a slug change after the OP renames
        // the post. last_snapshot_at advances to NOW() to drive the
        // service_post eligibility query (skip recently-polled).
        title: sql`EXCLUDED.title`,
        metadata: sql`EXCLUDED.metadata`,
        permalink: sql`EXCLUDED.permalink`,
        lastSnapshotAt: sql`NOW()`,
        // author / author_fullname intentionally omitted —
        // deletion-propagation cron may have nulled them; a re-poll
        // of the deleted post would otherwise restore the identity.
      },
    });
}

export interface RedditUserUpsert {
  username: string;
  redditId: string | null;
  accountAgeDays: number | null;
  linkKarma: number | null;
  commentKarma: number | null;
  totalKarma: number | null;
  isSuspended: boolean;
}

/** Upsert reddit_users_cache on (username). Refreshes karma fields and
 *  last_metadata_refresh_at. Uses COALESCE for the COALESCE-able fields
 *  so a poll that didn't surface a value (sub_poll responses include
 *  author_fullname but not karma) keeps existing data. */
export async function upsertRedditUser(dbCtx: DbOrTx, args: RedditUserUpsert): Promise<void> {
  await upsertRedditUsersMany(dbCtx, [args]);
}

/** Multi-row variant. The caller MUST de-duplicate by username before
 *  passing — Postgres' ON CONFLICT requires the values list to have at
 *  most one row per conflict target (otherwise: "cannot affect row a
 *  second time"). post_batch already builds a Set per author. */
export async function upsertRedditUsersMany(
  dbCtx: DbOrTx,
  rows: ReadonlyArray<RedditUserUpsert>,
): Promise<void> {
  if (rows.length === 0) return;
  await dbCtx
    .insert(redditUsersCache)
    .values(
      rows.map((r) => ({
        username: r.username.toLowerCase(),
        redditId: r.redditId,
        accountAgeDays: r.accountAgeDays,
        linkKarma: r.linkKarma,
        commentKarma: r.commentKarma,
        totalKarma: r.totalKarma,
        isSuspended: r.isSuspended,
        lastMetadataRefreshAt: sql`NOW()` as unknown as Date,
      })),
    )
    .onConflictDoUpdate({
      target: redditUsersCache.username,
      set: {
        redditId: sql`COALESCE(EXCLUDED.reddit_id, ${redditUsersCache.redditId})`,
        accountAgeDays: sql`COALESCE(EXCLUDED.account_age_days, ${redditUsersCache.accountAgeDays})`,
        linkKarma: sql`COALESCE(EXCLUDED.link_karma, ${redditUsersCache.linkKarma})`,
        commentKarma: sql`COALESCE(EXCLUDED.comment_karma, ${redditUsersCache.commentKarma})`,
        totalKarma: sql`COALESCE(EXCLUDED.total_karma, ${redditUsersCache.totalKarma})`,
        isSuspended: sql`EXCLUDED.is_suspended`,
        lastMetadataRefreshAt: sql`NOW()`,
      },
    });
}

export interface RedditSubredditUpsert {
  name: string;
  subredditId: string | null;
  subscribers: number | null;
  accountsActive: number | null;
  description: string | null;
  publicDescription: string | null;
  submissionMetadata?: Record<string, unknown>;
  rulesRawJson?: unknown;
  over18?: boolean;
  subredditType?: string | null;
}

/** Upsert reddit_subreddits_cache on (name). All optional fields
 *  COALESCE-preserve existing data: a sub_poll handler that didn't fetch
 *  about.json this tick won't clobber subscribers/description populated
 *  by a previous about-refresh. rulesRawJson likewise — only the rule-
 *  fetcher overwrites it. */
export async function upsertRedditSubreddit(
  dbCtx: DbOrTx,
  args: RedditSubredditUpsert,
): Promise<void> {
  await upsertRedditSubredditsMany(dbCtx, [args]);
}

/** Multi-row variant. Caller must de-dup by `name` before passing.
 *  See upsertRedditUsersMany header for the Postgres requirement. */
export async function upsertRedditSubredditsMany(
  dbCtx: DbOrTx,
  rows: ReadonlyArray<RedditSubredditUpsert>,
): Promise<void> {
  if (rows.length === 0) return;
  await dbCtx
    .insert(redditSubredditsCache)
    .values(
      rows.map((r) => {
        const hasRules = r.rulesRawJson !== undefined;
        return {
          name: r.name.toLowerCase(),
          subredditId: r.subredditId,
          subscribers: r.subscribers,
          accountsActive: r.accountsActive,
          description: r.description,
          publicDescription: r.publicDescription,
          submissionMetadata: r.submissionMetadata ?? {},
          rulesRawJson: hasRules ? (r.rulesRawJson as unknown) : null,
          rulesFetchedAt: hasRules ? (sql`NOW()` as unknown as Date) : null,
          over18: r.over18 ?? false,
          subredditType: r.subredditType ?? null,
          lastMetadataRefreshAt: sql`NOW()` as unknown as Date,
        };
      }),
    )
    .onConflictDoUpdate({
      target: redditSubredditsCache.name,
      set: {
        subredditId: sql`COALESCE(EXCLUDED.subreddit_id, ${redditSubredditsCache.subredditId})`,
        subscribers: sql`COALESCE(EXCLUDED.subscribers, ${redditSubredditsCache.subscribers})`,
        accountsActive: sql`COALESCE(EXCLUDED.accounts_active, ${redditSubredditsCache.accountsActive})`,
        description: sql`COALESCE(EXCLUDED.description, ${redditSubredditsCache.description})`,
        publicDescription: sql`COALESCE(EXCLUDED.public_description, ${redditSubredditsCache.publicDescription})`,
        submissionMetadata: sql`EXCLUDED.submission_metadata`,
        rulesRawJson: sql`COALESCE(EXCLUDED.rules_raw_json, ${redditSubredditsCache.rulesRawJson})`,
        rulesFetchedAt: sql`COALESCE(EXCLUDED.rules_fetched_at, ${redditSubredditsCache.rulesFetchedAt})`,
        over18: sql`EXCLUDED.over18`,
        subredditType: sql`COALESCE(EXCLUDED.subreddit_type, ${redditSubredditsCache.subredditType})`,
        lastMetadataRefreshAt: sql`NOW()`,
      },
    });
}

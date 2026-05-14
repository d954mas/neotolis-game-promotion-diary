// Reddit cache-table UPSERT helpers (D-RDT-CACHE-POPULATION).
//
// Three idempotent writers for the three lazy-populated public-data
// caches:
//   - upsertRedditPost      — reddit_posts        (PK post_id)
//   - upsertRedditUser      — reddit_users_cache  (PK username)
//   - upsertRedditSubreddit — reddit_subreddits_cache (PK name)
//
// All three are called from the worker handlers (sub_poll, author_poll,
// post_batch, post_single) on first encounter and on every subsequent
// poll. ON CONFLICT DO UPDATE refreshes the volatile fields (title,
// metadata, karma, subscribers) without re-inserting; PK clash → row
// update via SET.
//
// Deletion-propagation guard (D-RDT-DELETION-PROPAGATION): upsertRedditPost
// does NOT overwrite `author` / `author_fullname` to NULL — once
// reddit.cron.deletion-propagation has nulled those, a re-poll of a
// (still-) deleted post must not restore them. Pattern: omit the
// author* fields from the SET clause; the existing values persist.
//
// Reference: $lib/sources/youtube/server/* doesn't have a parallel
// helper because youtube_videos is the only public-data cache table
// and its UPSERT lives inline in backfill-channel.ts (single caller,
// not yet enough callers for the abstraction per AGENTS.md three-callers
// rule). Reddit needs three callers (post_single, sub_poll, author_poll)
// → abstraction earned.

import { sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { redditPosts, redditUsersCache, redditSubredditsCache } from "./schema/index.js";

/** Upsert reddit_posts on (post_id). Refreshes title / permalink /
 *  metadata / last_snapshot_at on conflict. Does NOT overwrite author
 *  fields — preserves deletion-propagation purges. */
export async function upsertRedditPost(
  dbCtx: DbOrTx,
  args: {
    postId: string;
    subreddit: string;
    author: string | null;
    authorFullname: string | null;
    permalink: string;
    title: string;
    submittedAt: Date;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await dbCtx
    .insert(redditPosts)
    .values({
      postId: args.postId,
      subreddit: args.subreddit,
      author: args.author,
      authorFullname: args.authorFullname,
      permalink: args.permalink,
      title: args.title,
      submittedAt: args.submittedAt,
      metadata: args.metadata,
      lastSnapshotAt: sql`NOW()` as unknown as Date,
    })
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

/** Upsert reddit_users_cache on (username). Refreshes karma fields and
 *  last_metadata_refresh_at. Uses COALESCE for reddit_id so a row
 *  populated with a t2_xxx fullname keeps it after a poll that didn't
 *  surface the fullname (sub_poll responses include author_fullname;
 *  some legacy paths only carry the username string). */
export async function upsertRedditUser(
  dbCtx: DbOrTx,
  args: {
    username: string;
    redditId: string | null;
    accountAgeDays: number | null;
    linkKarma: number | null;
    commentKarma: number | null;
    totalKarma: number | null;
    isSuspended: boolean;
  },
): Promise<void> {
  await dbCtx
    .insert(redditUsersCache)
    .values({
      username: args.username,
      redditId: args.redditId,
      accountAgeDays: args.accountAgeDays,
      linkKarma: args.linkKarma,
      commentKarma: args.commentKarma,
      totalKarma: args.totalKarma,
      isSuspended: args.isSuspended,
      lastMetadataRefreshAt: sql`NOW()` as unknown as Date,
    })
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

/** Upsert reddit_subreddits_cache on (name). All optional fields
 *  COALESCE-preserve existing data: a sub_poll handler that didn't fetch
 *  about.json this tick won't clobber subscribers/description populated
 *  from the daily about-fetch. rulesRawJson likewise — only the rule-
 *  fetcher overwrites it. */
export async function upsertRedditSubreddit(
  dbCtx: DbOrTx,
  args: {
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
  },
): Promise<void> {
  const hasRules = args.rulesRawJson !== undefined;
  await dbCtx
    .insert(redditSubredditsCache)
    .values({
      name: args.name,
      subredditId: args.subredditId,
      subscribers: args.subscribers,
      accountsActive: args.accountsActive,
      description: args.description,
      publicDescription: args.publicDescription,
      submissionMetadata: args.submissionMetadata ?? {},
      rulesRawJson: hasRules ? (args.rulesRawJson as unknown) : null,
      rulesFetchedAt: hasRules ? (sql`NOW()` as unknown as Date) : null,
      over18: args.over18 ?? false,
      subredditType: args.subredditType ?? null,
      lastMetadataRefreshAt: sql`NOW()` as unknown as Date,
    })
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

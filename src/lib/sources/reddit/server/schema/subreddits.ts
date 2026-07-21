// reddit_subreddits — our local copy of a public subreddit's own metadata
// (title, subscriber count, icon), scraped from the ScrapeCreators subreddit
// response we ALREADY pay for. The subject entity for a `reddit_subreddit`
// source — the role twitter_accounts / tiktok_accounts play for their kinds.
//
// PUBLIC-DATA — no `user_id` column by design. A subreddit's subscriber count is
// identical regardless of which tenant looked it up. The ESLint TENANT_TABLES
// allowlist extends `redditSubreddits` with an explicit "public external data,
// no tenant scope" comment.
//
// PK = `slug` — the lowercase subreddit slug (the `r/<slug>` name). Reddit
// FORBIDS renaming a subreddit and the slug is part of the canonical URL, so it
// is the ONE safe denormalization (AGENTS.md): an intrinsic identifier that is
// part of the URL/key itself, never a renameable display value. `title` (the
// human "About" title) IS renameable and lives here as OUR scraped truth, never
// aliased onto a consumer row.
//
// FOUNDATION ONLY: designed now so the DEFERRED per-subreddit percentile
// baselines (CHECKLIST §1c — "was this post above/below the sub's median?") are
// a cheap additive later. Those aggregates are NOT built now — the canonical
// pattern to copy when they land is a separate public-data aggregate table keyed
// by this slug. Retention forever — NO garbage collection.

import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const redditSubreddits = pgTable("reddit_subreddits", {
  // Lowercase subreddit slug (= data_sources.metadata.slug, the walk join
  // key). Reddit forbids subreddit rename → rename-proof intrinsic PK, the safe
  // denormalization.
  slug: text("slug").primaryKey(),
  // Upstream subreddit "About" title as scraped. OUR truth — NOT a denorm of
  // data_sources.display_name.
  title: text("title"),
  subscriberCount: integer("subscriber_count"),
  iconUrl: text("icon_url"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RedditSubreddit = typeof redditSubreddits.$inferSelect;
export type NewRedditSubreddit = typeof redditSubreddits.$inferInsert;

// reddit_accounts — our local copy of a public Reddit account's own metadata
// (display name, avatar, karma), scraped from the ScrapeCreators author-search
// response we ALREADY pay for (Phase 12, D-01 GO). The subject entity for a
// `reddit_account` source (CHECKLIST §1a) — the account-level anchor future
// per-account analytics / an account page will read.
//
// PUBLIC-DATA — no `user_id` column by design. An account's karma / avatar is
// identical regardless of which tenant looked it up; per-tenant copies would
// waste disk for no privacy benefit (mirrors twitter_accounts / tiktok_accounts
// / instagram_accounts public-data semantics). The ESLint TENANT_TABLES
// allowlist extends `redditAccounts` with an explicit "public external data,
// no tenant scope" comment so the no-unfiltered-tenant-query rule does not trip
// on legitimate `db.select().from(redditAccounts)` calls.
//
// SOURCE-OF-TRUTH, NOT a denorm of data_sources. `title` is the upstream Reddit
// display name as scraped — OUR truth for the account's OWN metadata, the same
// role twitter_accounts.name / tiktok_accounts.title play. It is NOT a copy of
// `data_sources.display_name` (the user-facing label a tenant renames freely);
// the two coexist by design and never alias each other (AGENTS.md no-denorm
// rule).
//
// PK = `username` — the LOWERCASE Reddit username. Reddit usernames are
// immutable and part of the canonical profile URL (reddit.com/user/<username>),
// so the username IS the rename-proof intrinsic key — the ONE safe
// denormalization (the same class as the subreddit slug). We do NOT fabricate a
// synthetic id from `author_fullname` (`t2_...`): the username is already stable
// and is the join key the author-walk keys on (RESEARCH A2). Lowercase-canonical
// so two subscribers pasting different-case spellings land on one row.
//
// COALESCE-preserve on non-ok / partial parse: a transient miss never blanks a
// working row (same rule as twitter_accounts / tiktok_accounts).
//
// Retention forever — NO garbage collection. The row IS the historical anchor
// for the account's per-post stats; future per-account baselines / an account
// page require it to persist independently of any referencing event/data_source.

import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const redditAccounts = pgTable("reddit_accounts", {
  // Lowercase immutable Reddit username (= data_sources.metadata.handle, the
  // author-walk join key). Rename-proof intrinsic PK — the safe denormalization.
  username: text("username").primaryKey(),
  // Upstream Reddit display name / title as scraped. OUR truth for the account's
  // own name — NOT a denorm of data_sources.display_name.
  title: text("title"),
  iconUrl: text("icon_url"),
  // Total karma (nullable — metrics-by-presence; ScrapeCreators may omit it).
  karma: integer("karma"),
  // Follower count (nullable — not always exposed).
  followerCount: integer("follower_count"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RedditAccount = typeof redditAccounts.$inferSelect;
export type NewRedditAccount = typeof redditAccounts.$inferInsert;

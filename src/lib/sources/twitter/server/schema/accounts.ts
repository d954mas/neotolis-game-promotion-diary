// twitter_accounts — our local copy of a public Twitter/X account's own metadata
// (current @handle / username, display name, avatar, follower count), scraped
// from the data we ALREADY pay for (the create-time profile resolve + the free
// feed owner object).
//
// PUBLIC-DATA — no `user_id` column by design. An account's display name /
// follower count is identical regardless of which tenant looked it up; per-tenant
// copies would waste disk for no privacy benefit (mirrors youtube_channels /
// telegram_channels / instagram_accounts / tiktok_accounts public-data
// semantics). The ESLint TENANT_TABLES allowlist
// (eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js) extends
// `twitterAccounts` with an explicit "public external data, no tenant scope"
// comment so the no-unfiltered-tenant-query rule does not trip on legitimate
// `db.select().from(twitterAccounts)` calls.
//
// SOURCE-OF-TRUTH, NOT a denorm of data_sources. This row is OUR truth for the
// account's OWN upstream metadata — the same role youtube_channels /
// telegram_channels / instagram_accounts / tiktok_accounts play (see their "this
// IS our truth" headers). It is NOT a copy of a value another table owns:
// `data_sources.display_name` is the user-facing label a tenant may rename
// freely; `twitter_accounts.name` is the upstream display name as scraped from
// Twitter/X. The two coexist by design and never alias each other (AGENTS.md
// no-denorm rule forbids caching data_sources.display_name HERE, and equally
// forbids caching this name onto a data_sources / twitter_posts row). The
// renameable @handle still lives on data_sources.metadata.handle for the provider
// query; `username` here is the current scraped @handle, retained on the entity
// for the future account page + a handle_aliases history (mirrors
// youtube_channels.handle_aliases / instagram_accounts.handle_aliases /
// tiktok_accounts.handle_aliases).
//
// PK = `account_id` — the stable Twitter/X numeric user id (= twitter_posts
// .account_id, the join key for future per-account analytics). Rename-proof: the
// @username changes, the numeric user id does not — so it is the stable group
// key, never a renameable display value (the Telegram channelKey lesson: key on
// the intrinsic id, never on a slug/handle that the user or upstream can
// re-spell). Twitter/X has NO secUid-equivalent secondary id — the numeric
// account id is the only key, so (unlike tiktok_accounts) there is no `sec_uid`
// column.
//
// Populated WITHOUT new credit burns (the cost guardrails / backfill cap are
// untouched):
//   - the create-time PAID profile resolve: UPSERTs the richer profile fields
//     (name / avatar / follower_count / username) it reads off the response we
//     already pay for. No extra fetch.
//   - the account walker (the feed response already fetched per page):
//     opportunistically UPSERTs account_id + username (+ avatar) from the feed's
//     top-level owner object, COALESCE-preserving the richer fields the profile
//     call set. A changed @handle appends to handle_aliases.
// Net: zero additional provider credits; the entity refreshes from data in hand.
//
// On a non-ok / partial parse the writer COALESCE-preserves the prior good
// metadata so a transient miss never blanks a working row (same rule as
// instagram_accounts / tiktok_accounts).
//
// Retention forever — NO garbage collection (mirrors youtube_channels /
// telegram_channels / instagram_accounts / tiktok_accounts). The row IS the
// historical anchor for the account's per-post stats; future account-level
// analytics (percentiles / baselines, an account page) require it to persist
// independently of any referencing event / data_source.
//
// FOUNDATION ONLY: this table is the subject entity (CHECKLIST §1a) that future
// per-account percentile baselines + an account page will read. Those are NOT
// built now — designed for, not implemented. The canonical percentile pattern to
// copy when they land is a separate public-data aggregate table keyed by
// the subject key.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const twitterAccounts = pgTable(
  // model twitter_accounts (accountId primaryKey)
  "twitter_accounts",
  {
    // Stable Twitter/X numeric user id (= twitter_posts.account_id). Rename-proof PK.
    accountId: text("account_id").primaryKey(),
    // Current scraped @handle (without the leading '@'). Renameable upstream →
    // a change appends the old value to handle_aliases and updates this column.
    username: text("username"),
    // Upstream display name (the name Twitter/X shows). OUR truth for the
    // account's own name — NOT a denorm of data_sources.display_name.
    name: text("name"),
    avatarUrl: text("avatar_url"),
    followerCount: integer("follower_count"),
    // Every @handle this account id has been seen under. The current username is
    // also kept here historically; the list widens on a handle change so a future
    // account page can resolve any historical @handle to this id (mirrors
    // youtube_channels.handle_aliases / instagram_accounts.handle_aliases /
    // tiktok_accounts.handle_aliases).
    handleAliases: text("handle_aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // GIN index supports `= ANY(handle_aliases)` membership lookups (future
    // account-page resolution of a historical @handle to this id).
    handleAliasesIdx: index("idx_twitter_accounts_handle_aliases").using("gin", t.handleAliases),
  }),
);

export type TwitterAccount = typeof twitterAccounts.$inferSelect;
export type NewTwitterAccount = typeof twitterAccounts.$inferInsert;

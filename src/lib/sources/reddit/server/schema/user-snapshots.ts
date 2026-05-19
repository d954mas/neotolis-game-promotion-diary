// reddit_user_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Time-series of
// per-author karma (link_karma / comment_karma / total_karma) captured
// daily.
//
// Snapshots are captured for OWNED reddit_account data_sources only —
// per-author analytics for arbitrary handles aren't worth the API
// budget today. They land via a dedicated about-refresh queue work
// item (NOT inline with author_poll's /submitted.json fetch — the
// global pacer would deny a second redditFetch in the same tick).
//
// `(username, polled_at)` composite PK makes within-the-minute retries
// idempotent (insert via date_trunc('minute', NOW())).
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope (time-series; OWNED reddit_accounts only)" comment.

import { pgTable, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";
import { redditUsersCache } from "./users.js";

export const redditUserSnapshots = pgTable(
  "reddit_user_snapshots",
  {
    // ON UPDATE CASCADE / ON DELETE CASCADE — see migration
    // 0040_phase03_1_lowercase_reddit_identifiers.sql header. Username
    // is the PK of reddit_users_cache; lowercase normalisation must
    // re-point children automatically, and a cache row drop (collision
    // dedup or future cleanup path) drops derived snapshots too.
    username: text("username")
      .notNull()
      .references(() => redditUsersCache.username, {
        onUpdate: "cascade",
        onDelete: "cascade",
      }),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    linkKarma: integer("link_karma"),
    commentKarma: integer("comment_karma"),
    totalKarma: integer("total_karma"),
  },
  (t) => ({
    // Composite PK — see post-snapshots.ts for rationale (PK > uniqueIndex
    // for replication identity and ORM tooling first-class status).
    pk: primaryKey({ columns: [t.username, t.polledAt] }),
  }),
);

export type RedditUserSnapshot = typeof redditUserSnapshots.$inferSelect;
export type NewRedditUserSnapshot = typeof redditUserSnapshots.$inferInsert;

// reddit_user_snapshots.
//
// PUBLIC-DATA TABLE — no `user_id` column by design. Time-series of
// per-author karma (link_karma / comment_karma / total_karma) captured
// daily.
//
// Per D-RDT-USER-SNAPSHOTS, snapshots are captured opportunistically by
// the `author_poll` worker handler when polling
// `/user/X/submitted.json` for OWNED `reddit_account` data_sources
// (the response payload already includes user-level karma fields, so no
// extra HTTP call against the 8/min ceiling). For non-owned authors,
// snapshots are NOT captured today; can be extended later if per-author
// analytics surface.
//
// `(username, polled_at)` UNIQUE makes within-the-minute retries
// idempotent (date_trunc('minute', NOW()) on insert — see D-RDT-
// SNAPSHOTS).
//
// ESLint allowlist mirror in eslint-plugin-tenant-scope/no-unfiltered-
// tenant-query.js with the explicit "public external data, no tenant
// scope (time-series; OWNED reddit_accounts only)" comment.

import { pgTable, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { redditUsersCache } from "./users.js";

export const redditUserSnapshots = pgTable(
  "reddit_user_snapshots",
  {
    username: text("username")
      .notNull()
      .references(() => redditUsersCache.username),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    linkKarma: integer("link_karma"),
    commentKarma: integer("comment_karma"),
    totalKarma: integer("total_karma"),
  },
  (t) => ({
    usernamePolledUnq: uniqueIndex("reddit_user_snapshots_username_polled_at_uq").on(
      t.username,
      t.polledAt,
    ),
  }),
);

export type RedditUserSnapshot = typeof redditUserSnapshots.$inferSelect;
export type NewRedditUserSnapshot = typeof redditUserSnapshots.$inferInsert;

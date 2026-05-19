// Consecutive-404 tracker for sub-poll / author-poll.
//
// One 404 from Reddit doesn't mean "the subreddit is gone forever" — it
// can be a banned-then-unbanned sub, a brief unavailability, or Reddit
// itself momentarily degraded. We only flag subscribers as
// needs-reconnect after THRESHOLD consecutive 404s within WINDOW.
//
// Counter lives on the cross-tenant cache row (one walk per sub/user,
// every subscriber shares the same state). A successful poll resets the
// counter to 0; a 404 increments it. A gap longer than WINDOW between
// two 404s also resets the counter (treats them as separate incidents,
// not a continuing burst).

import { sql } from "drizzle-orm";
import type { DbOrTx } from "$lib/server/db/client.js";
import { redditSubredditsCache, redditUsersCache } from "./schema/index.js";

/** Flag-needs-reconnect fires only after this many 404s within
 *  `NOT_FOUND_FLAG_WINDOW_MS`. */
export const NOT_FOUND_FLAG_THRESHOLD = 3;

/** Rolling window — two 404s separated by more than this are treated as
 *  separate incidents (counter resets). 24h gives small operators a
 *  buffer for Reddit-side blips without hiding a real outage. */
export const NOT_FOUND_FLAG_WINDOW_MS = 24 * 60 * 60_000;

export type NotFoundKind = "subreddit" | "user";

export interface NotFoundRecordResult {
  /** Counter value AFTER this 404 was recorded. */
  count: number;
  /** True when caller should fan-out the needs-reconnect flag to every
   *  subscriber. False means "still inside threshold tolerance, just
   *  bump the counter and move on". */
  shouldFlag: boolean;
}

/** Record one 404 against the cross-tenant cache row. UPSERT semantics:
 *  cache row may not exist yet (first-ever poll is the 404 itself).
 *  Returns the post-increment count and the flag decision. */
export async function recordNotFound(
  dbCtx: DbOrTx,
  kind: NotFoundKind,
  key: string,
): Promise<NotFoundRecordResult> {
  const result =
    kind === "subreddit"
      ? await dbCtx.execute<{ not_found_count: number }>(sql`
          INSERT INTO ${redditSubredditsCache} (name, not_found_count, last_not_found_at)
          VALUES (${key}, 1, NOW())
          ON CONFLICT (name) DO UPDATE
          SET not_found_count = CASE
              WHEN ${redditSubredditsCache.lastNotFoundAt} IS NULL
                OR ${redditSubredditsCache.lastNotFoundAt} < NOW() - (${NOT_FOUND_FLAG_WINDOW_MS} || ' milliseconds')::interval
              THEN 1
              ELSE ${redditSubredditsCache.notFoundCount} + 1
            END,
            last_not_found_at = NOW()
          RETURNING not_found_count
        `)
      : await dbCtx.execute<{ not_found_count: number }>(sql`
          INSERT INTO ${redditUsersCache} (username, not_found_count, last_not_found_at)
          VALUES (${key}, 1, NOW())
          ON CONFLICT (username) DO UPDATE
          SET not_found_count = CASE
              WHEN ${redditUsersCache.lastNotFoundAt} IS NULL
                OR ${redditUsersCache.lastNotFoundAt} < NOW() - (${NOT_FOUND_FLAG_WINDOW_MS} || ' milliseconds')::interval
              THEN 1
              ELSE ${redditUsersCache.notFoundCount} + 1
            END,
            last_not_found_at = NOW()
          RETURNING not_found_count
        `);

  const row = (result as unknown as { rows?: Array<{ not_found_count: number | string }> })
    .rows?.[0];
  const count = Number(row?.not_found_count ?? 1);
  return {
    count,
    shouldFlag: count >= NOT_FOUND_FLAG_THRESHOLD,
  };
}

/** Reset the consecutive-404 counter after a successful poll. No-op when
 *  the counter is already 0 (avoids a write on every healthy tick). */
export async function resetNotFoundOnSuccess(
  dbCtx: DbOrTx,
  kind: NotFoundKind,
  key: string,
): Promise<void> {
  if (kind === "subreddit") {
    await dbCtx.execute(sql`
      UPDATE ${redditSubredditsCache}
      SET not_found_count = 0, last_not_found_at = NULL
      WHERE name = ${key}
        AND (${redditSubredditsCache.notFoundCount} > 0
             OR ${redditSubredditsCache.lastNotFoundAt} IS NOT NULL)
    `);
  } else {
    await dbCtx.execute(sql`
      UPDATE ${redditUsersCache}
      SET not_found_count = 0, last_not_found_at = NULL
      WHERE username = ${key}
        AND (${redditUsersCache.notFoundCount} > 0
             OR ${redditUsersCache.lastNotFoundAt} IS NOT NULL)
    `);
  }
}

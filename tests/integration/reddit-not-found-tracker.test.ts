// Consecutive-404 tracker — gate flag-needs-reconnect on N-in-window.
//
// Pre-fix: one 404 from Reddit immediately flagged every subscriber.
// Post-fix: only flag after `NOT_FOUND_FLAG_THRESHOLD` (3) consecutive
// 404s within `NOT_FOUND_FLAG_WINDOW_MS` (24h). A successful poll resets.
//
// Test matrix:
//   1. First 404 on a never-seen sub: count=1, shouldFlag=false, row created.
//   2. Three quick 404s: third returns shouldFlag=true.
//   3. Successful reset takes the row back to count=0.
//   4. After reset, the 404 series starts over from 1.
//   5. Reset is idempotent on already-clean rows.
//   6. Both kinds (subreddit + user) share the same shape.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import {
  redditSubredditsCache,
  redditUsersCache,
} from "../../src/lib/sources/reddit/server/schema/index.js";
import { eq, sql } from "drizzle-orm";
import {
  NOT_FOUND_FLAG_THRESHOLD,
  recordNotFound,
  resetNotFoundOnSuccess,
} from "../../src/lib/sources/reddit/server/not-found-tracker.js";

async function readSubredditCounter(name: string): Promise<{ count: number; lastAt: Date | null }> {
  const rows = await db
    .select({
      count: redditSubredditsCache.notFoundCount,
      lastAt: redditSubredditsCache.lastNotFoundAt,
    })
    .from(redditSubredditsCache)
    .where(eq(redditSubredditsCache.name, name));
  return rows[0] ?? { count: 0, lastAt: null };
}

describe("not-found-tracker (consecutive-404 gate)", () => {
  beforeEach(async () => {
    // Truncate happens via global setup.ts; nothing extra needed here.
  });

  it("threshold constant matches the engine policy (default = 3)", () => {
    expect(NOT_FOUND_FLAG_THRESHOLD).toBe(3);
  });

  it("first 404 on a never-seen sub creates the cache row, count=1, no flag", async () => {
    const r = await recordNotFound(db, "subreddit", "test_sub_first");
    expect(r.count).toBe(1);
    expect(r.shouldFlag).toBe(false);
    const persisted = await readSubredditCounter("test_sub_first");
    expect(persisted.count).toBe(1);
    expect(persisted.lastAt).not.toBeNull();
  });

  it("third consecutive 404 trips the flag", async () => {
    const sub = "test_sub_trip";
    const a = await recordNotFound(db, "subreddit", sub);
    expect(a.count).toBe(1);
    expect(a.shouldFlag).toBe(false);
    const b = await recordNotFound(db, "subreddit", sub);
    expect(b.count).toBe(2);
    expect(b.shouldFlag).toBe(false);
    const c = await recordNotFound(db, "subreddit", sub);
    expect(c.count).toBe(3);
    expect(c.shouldFlag).toBe(true);
  });

  it("resetNotFoundOnSuccess clears the counter", async () => {
    const sub = "test_sub_reset";
    await recordNotFound(db, "subreddit", sub);
    await recordNotFound(db, "subreddit", sub);
    await resetNotFoundOnSuccess(db, "subreddit", sub);
    const persisted = await readSubredditCounter(sub);
    expect(persisted.count).toBe(0);
    expect(persisted.lastAt).toBeNull();
  });

  it("reset → new 404 starts at 1 (no carryover into the next series)", async () => {
    const sub = "test_sub_carryover";
    await recordNotFound(db, "subreddit", sub);
    await recordNotFound(db, "subreddit", sub);
    await resetNotFoundOnSuccess(db, "subreddit", sub);
    const after = await recordNotFound(db, "subreddit", sub);
    expect(after.count).toBe(1);
    expect(after.shouldFlag).toBe(false);
  });

  it("reset is a no-op on never-failed rows", async () => {
    // Seed a clean cache row (mirrors what a successful poll's UPSERT writes).
    await db.execute(sql`
      INSERT INTO reddit_subreddits_cache (name) VALUES ('test_sub_clean')
      ON CONFLICT (name) DO NOTHING
    `);
    await expect(
      resetNotFoundOnSuccess(db, "subreddit", "test_sub_clean"),
    ).resolves.toBeUndefined();
    const persisted = await readSubredditCounter("test_sub_clean");
    expect(persisted.count).toBe(0);
    expect(persisted.lastAt).toBeNull();
  });

  it("user kind tracks an independent counter", async () => {
    const handle = "test_user_independent";
    const a = await recordNotFound(db, "user", handle);
    expect(a.count).toBe(1);
    const b = await recordNotFound(db, "user", handle);
    expect(b.count).toBe(2);
    // Verify the user cache row carries the counter, NOT the subreddit cache.
    const userRows = await db
      .select({
        count: redditUsersCache.notFoundCount,
      })
      .from(redditUsersCache)
      .where(eq(redditUsersCache.username, handle));
    expect(userRows[0]?.count).toBe(2);
    // And ensure no subreddit row was created with that name.
    const subRows = await db
      .select({ count: redditSubredditsCache.notFoundCount })
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, handle));
    expect(subRows.length).toBe(0);
  });

  it("404 series with last_not_found_at > window-old resets count to 1", async () => {
    const sub = "test_sub_window";
    // Seed: count=2 with last_not_found_at 25h ago (outside the 24h window).
    await db.execute(sql`
      INSERT INTO reddit_subreddits_cache (name, not_found_count, last_not_found_at)
      VALUES (${sub}, 2, NOW() - INTERVAL '25 hours')
      ON CONFLICT (name) DO UPDATE
      SET not_found_count = 2, last_not_found_at = NOW() - INTERVAL '25 hours'
    `);
    const r = await recordNotFound(db, "subreddit", sub);
    // Out-of-window — counter resets to 1, NOT 3.
    expect(r.count).toBe(1);
    expect(r.shouldFlag).toBe(false);
  });
});

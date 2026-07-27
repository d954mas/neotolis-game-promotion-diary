// Migration 0075 is a hand-written DATA migration. Execute the shipped SQL against
// real Postgres so its destructive scope and idempotency cannot drift from the policy
// documented in AGENTS.md.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/adapter-refresh-queue.js");

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0075_reddit_legacy_refresh_queue_cleanup.sql"),
  "utf-8",
);

async function runMigration(): Promise<void> {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed !== "") await db.execute(sql.raw(trimmed));
  }
}

describe("migration 0075 — legacy Reddit refresh queue cleanup", () => {
  it("deletes only reddit_account rows and is idempotent", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    await db.insert(adapterRefreshQueue).values([
      {
        adapterKind: "reddit_account",
        queueName: "user_post",
        type: "post_stats",
        payload: { post_id: `reddit-${suffix}` },
        priority: 0,
      },
      {
        adapterKind: "youtube_channel",
        queueName: "user_video",
        type: "video_stats",
        payload: { video_id: `youtube-${suffix}` },
        priority: 0,
      },
    ]);

    await runMigration();
    await runMigration();

    const redditRows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "reddit_account"));
    expect(redditRows).toHaveLength(0);

    const youtubeRows = await db
      .select({ payload: adapterRefreshQueue.payload })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "youtube_channel"));
    expect(youtubeRows).toContainEqual({ payload: { video_id: `youtube-${suffix}` } });
  });
});

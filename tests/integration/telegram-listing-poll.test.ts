// Telegram listing poll — integration tests (real Postgres via tests/setup.ts).
//
// Plan 09-03 fills the SNAPSHOT-WRITER half: writeTelegramSnapshot is the
// two-phase idempotent writer (UPSERT telegram_posts + INSERT
// telegram_post_snapshots ON CONFLICT (post_id, polled_at) DO NOTHING, with
// polled_at minute-truncated). These cases drive it directly against real
// Postgres — no DB mocks (CLAUDE.md), public-data so no userId scope.
//
// The HANDLER-level cases (a full listing poll that parses HTML → calls the
// writer per parsed post) land in Plan 04/05 once the handler exists; they
// stay skipped here.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { telegramPosts, telegramPostSnapshots } from "../../src/lib/server/db/schema/index.js";
import { writeTelegramSnapshot } from "../../src/lib/sources/telegram/server/snapshots.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function readPost(postId: string) {
  const [row] = await db.select().from(telegramPosts).where(eq(telegramPosts.postId, postId));
  return row;
}

async function readSnapshots(postId: string) {
  return db.select().from(telegramPostSnapshots).where(eq(telegramPostSnapshots.postId, postId));
}

describe("writeTelegramSnapshot — two-phase idempotent writer (Plan 09-03)", () => {
  it("status='ok' with a view count → one telegram_posts row + one snapshot row", async () => {
    const postId = `durov/${uniq()}`;
    await writeTelegramSnapshot({
      postId,
      channelKey: "1006503122",
      textSnippet: "hello",
      mediaKind: "photo",
      thumbnailUrl: "https://cdn.telegram.org/a.jpg",
      externalUrl: `https://t.me/${postId}`,
      publishedAt: new Date("2026-06-01T00:00:00Z"),
      viewCount: 12300,
      status: "ok",
    });

    const post = await readPost(postId);
    expect(post).toBeDefined();
    expect(post!.lastPollStatus).toBe("ok");
    expect(post!.lastPolledAt).not.toBeNull();
    expect(post!.pollFailureCount).toBe(0);

    const snaps = await readSnapshots(postId);
    expect(snaps).toHaveLength(1);
    expect(Number(snaps[0]!.viewCount)).toBe(12300);
  });

  it("called TWICE within the same minute (same postId) → still exactly ONE snapshot row", async () => {
    const postId = `durov/${uniq()}`;
    const args = { postId, viewCount: 500, status: "ok" as const };
    await writeTelegramSnapshot(args);
    await writeTelegramSnapshot({ ...args, viewCount: 999 }); // same minute → ON CONFLICT DO NOTHING

    const snaps = await readSnapshots(postId);
    expect(snaps).toHaveLength(1);
    // First write wins (DO NOTHING) — the second is dropped, not upserted.
    expect(Number(snaps[0]!.viewCount)).toBe(500);
  });

  it("viewCount=null, status='ok' → telegram_posts updates but NO snapshot row", async () => {
    const postId = `durov/${uniq()}`;
    await writeTelegramSnapshot({ postId, viewCount: null, status: "ok" });

    const post = await readPost(postId);
    expect(post).toBeDefined();
    expect(post!.lastPolledAt).not.toBeNull();
    expect(post!.lastPollStatus).toBe("ok");

    const snaps = await readSnapshots(postId);
    expect(snaps).toHaveLength(0);
  });

  it("status='not_found' → poll_failure_count increments; a prior thumbnail_url is PRESERVED (COALESCE)", async () => {
    const postId = `durov/${uniq()}`;
    // Seed a good poll first (sets a thumbnail + failure count 0).
    await writeTelegramSnapshot({
      postId,
      thumbnailUrl: "https://cdn.telegram.org/good.jpg",
      viewCount: 10,
      status: "ok",
    });
    // Now a failed poll carrying NO thumbnail.
    await writeTelegramSnapshot({
      postId,
      thumbnailUrl: null,
      viewCount: null,
      status: "not_found",
    });

    const post = await readPost(postId);
    expect(post!.lastPollStatus).toBe("not_found");
    expect(post!.pollFailureCount).toBe(1);
    // The last-good thumbnail survives — a transient failure must not blank the cover.
    expect(post!.thumbnailUrl).toBe("https://cdn.telegram.org/good.jpg");

    // No snapshot row added by the non-ok poll.
    const snaps = await readSnapshots(postId);
    expect(snaps).toHaveLength(1);
  });

  it("a second OK poll resets poll_failure_count to 0", async () => {
    const postId = `durov/${uniq()}`;
    await writeTelegramSnapshot({ postId, viewCount: null, status: "not_found" });
    await writeTelegramSnapshot({ postId, viewCount: null, status: "not_found" });
    let post = await readPost(postId);
    expect(post!.pollFailureCount).toBe(2);

    await writeTelegramSnapshot({ postId, viewCount: 42, status: "ok" });
    post = await readPost(postId);
    expect(post!.pollFailureCount).toBe(0);
    expect(post!.lastPollStatus).toBe("ok");
  });
});

describe.skip("telegram listing poll handler (filled in Plan 04/05)", () => {
  it.skip("writes a telegram_posts row + a telegram_post_snapshots row per parsed post");
  it.skip("is idempotent on (post_id, polled_at-minute) via INSERT ... ON CONFLICT DO NOTHING");
});

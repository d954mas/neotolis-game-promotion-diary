// Telegram listing poll — integration tests (real Postgres via tests/setup.ts).
//
// Plan 09-03 fills the SNAPSHOT-WRITER half: writeTelegramSnapshot is the
// two-phase idempotent writer (UPSERT telegram_posts + INSERT
// telegram_post_snapshots ON CONFLICT (post_id, polled_at) DO NOTHING, with
// polled_at minute-truncated). These cases drive it directly against real
// Postgres — no DB mocks (CLAUDE.md), public-data so no userId scope.
//
// Plan 09-05 fills the HANDLER-level half now that the adapter is REGISTERED:
//   - createSource(telegram_channel) returns a data_sources row (no 422
//     kind_not_yet_functional) and persists isOwnedByMe (the value future
//     event-creation / feed enrichment inherits as author_is_me, D-02 — the
//     telegram listing/backfill handlers themselves write snapshots, not
//     events, so the source row IS where the inheritance value lives today).
//   - the registered listing-poll handler, driven against a fixture listing
//     (pollListing spied), writes telegram_posts + one telegram_post_snapshots
//     row per post-with-views, idempotent within the same minute.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { telegramPosts, telegramPostSnapshots } from "../../src/lib/server/db/schema/index.js";
import { writeTelegramSnapshot } from "../../src/lib/sources/telegram/server/snapshots.js";
import { telegramChannelAdapterCore } from "../../src/lib/sources/telegram/server/adapter.js";
import { handleTelegramListingPoll } from "../../src/lib/sources/telegram/server/handlers/listing-poll.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

type ParsedTelegramListing = Awaited<ReturnType<typeof telegramChannelAdapterCore.pollListing>>;

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface FixturePost {
  externalId: string;
  publishedAt: Date | null;
  viewCount: number | null;
}

function listing(posts: FixturePost[]): ParsedTelegramListing {
  return {
    channelTitle: "Fixture Channel",
    status: "ok",
    posts: posts.map((p) => ({
      externalId: p.externalId,
      publishedAt: p.publishedAt,
      viewCount: p.viewCount,
      textSnippet: "snip",
      mediaKind: null,
      thumbnailUrl: null,
    })),
    nextBeforeCursor: null,
  };
}

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

// Handler-level + create-path cases (Plan 09-05 — the adapter is now REGISTERED).
describe("telegram createSource (registered — Plan 09-05)", () => {
  it("createSource(telegram_channel) returns a data_sources row (no 422 kind_not_yet_functional)", async () => {
    const user = await seedUserDirectly({ email: `tg-cs-${uniq()}@test.local` });
    const channel = `acme_${uniq()}`;
    const source = await createSource(
      user.id,
      {
        kind: "telegram_channel",
        handleUrl: `https://t.me/${channel}`,
        isOwnedByMe: false,
        autoImport: false, // skip the onSourceCreated backfill enqueue (no pg-boss in this test)
      },
      "127.0.0.1",
    );

    expect(source.kind).toBe("telegram_channel");
    // normalizeSourceOnCreate canonicalizes the handle + injects metadata.channel
    // (the URL-intrinsic provider key the lane uses).
    expect(source.handleUrl).toBe(`https://t.me/${channel}`);
    expect((source.metadata as { channel?: string }).channel).toBe(channel);
  });

  it("author_is_me inherits from isOwnedByMe on the created source (D-02)", async () => {
    const user = await seedUserDirectly({ email: `tg-own-${uniq()}@test.local` });

    // isOwnedByMe=true is persisted on the source row — the value that
    // future telegram_post event-creation / feed enrichment reads as
    // author_is_me (the listing/backfill handlers write snapshots, not events,
    // so the source row is where the inheritance value lives today).
    const owned = await createSource(
      user.id,
      {
        kind: "telegram_channel",
        handleUrl: `https://t.me/mine_${uniq()}`,
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );
    expect(owned.isOwnedByMe).toBe(true);

    const notMine = await createSource(
      user.id,
      {
        kind: "telegram_channel",
        handleUrl: `https://t.me/theirs_${uniq()}`,
        isOwnedByMe: false,
        autoImport: false,
      },
      "127.0.0.1",
    );
    expect(notMine.isOwnedByMe).toBe(false);
  });

  it("an unparseable telegram handle is rejected at create (invalid_handle_url 422)", async () => {
    const user = await seedUserDirectly({ email: `tg-bad-${uniq()}@test.local` });
    await expect(
      createSource(
        user.id,
        {
          kind: "telegram_channel",
          handleUrl: "https://example.com/not-telegram",
          isOwnedByMe: false,
          autoImport: false,
        },
        "127.0.0.1",
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("telegram listing-poll handler (registered — Plan 09-05)", () => {
  it("writes a telegram_posts row + a telegram_post_snapshots row per parsed post", async () => {
    const channel = `lp_${uniq()}`;
    const posts = [
      { externalId: `${channel}/12`, publishedAt: new Date("2026-06-01T00:00:00Z"), viewCount: 1500 },
      { externalId: `${channel}/11`, publishedAt: new Date("2026-05-31T00:00:00Z"), viewCount: 900 },
    ];
    const pollSpy = vi
      .spyOn(telegramChannelAdapterCore, "pollListing")
      .mockResolvedValueOnce(listing(posts));

    const r = await handleTelegramListingPoll({ channel });
    expect(r.status).toBe("ok");
    expect(r.written).toBe(2);
    expect(pollSpy).toHaveBeenCalledWith(channel);

    for (const p of posts) {
      const post = await readPost(p.externalId);
      expect(post, `telegram_posts row for ${p.externalId}`).toBeDefined();
      expect(post!.lastPollStatus).toBe("ok");
      const snaps = await readSnapshots(p.externalId);
      expect(snaps).toHaveLength(1);
      expect(Number(snaps[0]!.viewCount)).toBe(p.viewCount);
    }

    vi.restoreAllMocks();
  });

  it("a re-run within the same minute is idempotent (no duplicate snapshot rows)", async () => {
    const channel = `lpidem_${uniq()}`;
    const posts = [
      { externalId: `${channel}/7`, publishedAt: new Date("2026-06-01T00:00:00Z"), viewCount: 42 },
    ];
    vi.spyOn(telegramChannelAdapterCore, "pollListing").mockResolvedValue(listing(posts));

    await handleTelegramListingPoll({ channel });
    await handleTelegramListingPoll({ channel }); // same minute → ON CONFLICT DO NOTHING

    const snaps = await readSnapshots(`${channel}/7`);
    expect(snaps).toHaveLength(1);

    vi.restoreAllMocks();
  });

  it("a not_found listing writes nothing (no post ids to snapshot)", async () => {
    const channel = `lpnf_${uniq()}`;
    vi.spyOn(telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce({
      channelTitle: null,
      status: "not_found",
      posts: [],
      nextBeforeCursor: null,
    });

    const r = await handleTelegramListingPoll({ channel });
    expect(r.status).toBe("not_found");
    expect(r.written).toBe(0);

    vi.restoreAllMocks();
  });
});

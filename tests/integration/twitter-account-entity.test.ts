// Twitter/X account subject entity (CHECKLIST §1a) — twitter_accounts is UPSERTed
// from the create-time profile resolve + the free feed owner object with NO extra
// credit, COALESCE-preserving prior good metadata on a partial parse, and keyed on
// the stable numeric account_id (rename-proof, the Telegram channelKey lesson). It
// is OUR truth for the account's own upstream metadata, NOT a denorm of
// data_sources.display_name.
//
// Drives writeSnapshot (share_count + the D-05 raw retweet/quote/bookmark stored)
// + upsertTwitterAccount + the create-time resolveHandleToAccountId path directly
// against real Postgres; the twitterapi.io boundary is faked at the PROVIDER SEAM
// (vi.mock of provider/registry's getSocialProvider), NEVER the DB.
//
// Requirements: PLAT-03 (CHECKLIST §1a subject entity; D-05 raw components).
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { ResolvedAccount } from "../../src/lib/sources/social-provider.js";

// Provider seam mock for the ADAPTER-PATH test (resolveHandleToAccountId): the
// provider's resolveAccount returns a ResolvedAccount, so we prove the create-time
// resolve THREADS name/avatar/follower_count through to upsertTwitterAccount. The
// DB is real.
let scriptedResolved: ResolvedAccount | null = null;
vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTwitterConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "twitter") return null;
      return {
        name: "twitterapi.io",
        async resolveAccount(): Promise<ResolvedAccount | null> {
          return scriptedResolved;
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { twitterAccounts, twitterPosts, twitterPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { writeSnapshot, upsertTwitterAccount } =
  await import("../../src/lib/sources/twitter/server/snapshots.js");
const { twitterAccountAdapterCore } =
  await import("../../src/lib/sources/twitter/server/adapter.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function readAccount(accountId: string) {
  const [row] = await db
    .select()
    .from(twitterAccounts)
    .where(eq(twitterAccounts.accountId, accountId))
    .limit(1);
  return row;
}

describe("twitter account subject entity (CHECKLIST §1a)", () => {
  it("[11-03] upserts twitter_accounts from the free feed owner object (zero extra credit)", async () => {
    const accountId = `acct_${uniq()}`;
    // The FREE feed owner object carries account_id + username (+ avatar), but NOT
    // the richer follower_count / name fields.
    await upsertTwitterAccount({
      accountId,
      username: "ConcernedApe",
      avatarUrl: "https://pbs.twimg.com/avatar.jpg",
    });

    const row = await readAccount(accountId);
    expect(row).toBeDefined();
    expect(row!.accountId).toBe(accountId);
    expect(row!.username).toBe("ConcernedApe");
    expect(row!.avatarUrl).toBe("https://pbs.twimg.com/avatar.jpg");
    expect(row!.handleAliases).toEqual(["ConcernedApe"]);
  });

  it("[11-03] the create-time profile resolve fills the richer fields (name/avatar/follower_count)", async () => {
    const accountId = `acct_${uniq()}`;
    // The provider resolveAccount returns the rich profile fields (read off the SAME
    // response — no extra credit). The adapter must thread them into
    // upsertTwitterAccount.
    scriptedResolved = {
      accountId,
      displayName: "ConcernedApe",
      username: "ConcernedApe",
      fullName: "ConcernedApe",
      avatarUrl: "https://pbs.twimg.com/profile.jpg",
      followerCount: 1_500_000,
    };

    const result = await twitterAccountAdapterCore.resolveHandleToAccountId("ConcernedApe");
    expect(result).toEqual({ accountId, displayName: "ConcernedApe" });

    const row = await readAccount(accountId);
    expect(row!.accountId).toBe(accountId);
    expect(row!.username).toBe("ConcernedApe");
    expect(row!.name).toBe("ConcernedApe");
    expect(row!.avatarUrl).toBe("https://pbs.twimg.com/profile.jpg");
    expect(row!.followerCount).toBe(1_500_000);
  });

  it("[11-03] keyed on the rename-proof numeric account_id, never the renameable @handle", async () => {
    const accountId = `acct_${uniq()}`;
    // The PAID profile resolve sets the rich fields.
    await upsertTwitterAccount({
      accountId,
      username: "oldhandle",
      name: "Studio",
      avatarUrl: "https://pbs.twimg.com/profile.jpg",
      followerCount: 4_700_000,
    });
    // A FREE feed refresh carries username + a fresh avatar but NO follower_count /
    // name (the feed owner never has the richer fields). The COALESCE-preserve must
    // keep them — anchored on the SAME account_id (NOT the handle).
    await upsertTwitterAccount({
      accountId,
      username: "oldhandle",
      avatarUrl: "https://pbs.twimg.com/feed-avatar.jpg",
    });

    const row = await readAccount(accountId);
    expect(row!.accountId).toBe(accountId);
    expect(row!.avatarUrl).toBe("https://pbs.twimg.com/feed-avatar.jpg");
    // Rich fields PRESERVED across the cheap refresh.
    expect(row!.followerCount).toBe(4_700_000);
    expect(row!.name).toBe("Studio");
  });

  it("[11-03] a changed @handle appends the old value to handle_aliases", async () => {
    const accountId = `acct_${uniq()}`;
    await upsertTwitterAccount({ accountId, username: "oldhandle", name: "Old", followerCount: 100 });
    const first = await readAccount(accountId);
    expect(first!.username).toBe("oldhandle");
    const firstSeen = first!.firstSeenAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    // Rename: SAME account_id (rename-proof key), new handle + grown follower count.
    await upsertTwitterAccount({ accountId, username: "newhandle", name: "New", followerCount: 250 });

    const second = await readAccount(accountId);
    expect(second!.accountId).toBe(accountId);
    expect(second!.username).toBe("newhandle");
    expect(second!.name).toBe("New");
    expect(second!.followerCount).toBe(250);
    // Both handles retained; first_seen unchanged (same entity).
    expect(second!.handleAliases.sort()).toEqual(["newhandle", "oldhandle"]);
    expect(second!.firstSeenAt.getTime()).toBe(firstSeen);
    // A re-write of the SAME handle does NOT grow handle_aliases (no duplicate).
    await upsertTwitterAccount({ accountId, username: "newhandle" });
    const third = await readAccount(accountId);
    expect(third!.handleAliases.sort()).toEqual(["newhandle", "oldhandle"]);
  });

  it("[11-03] a partial/failed parse COALESCE-preserves the prior good metadata", async () => {
    const accountId = `acct_${uniq()}`;
    await upsertTwitterAccount({
      accountId,
      username: "handle",
      name: "Good Name",
      avatarUrl: "https://pbs.twimg.com/good.jpg",
      followerCount: 500,
    });
    // A transient miss: all rich fields null (only the key + a null parse).
    await upsertTwitterAccount({
      accountId,
      username: null,
      name: null,
      avatarUrl: null,
      followerCount: null,
    });

    const row = await readAccount(accountId);
    expect(row!.username).toBe("handle");
    expect(row!.name).toBe("Good Name");
    expect(row!.avatarUrl).toBe("https://pbs.twimg.com/good.jpg");
    expect(row!.followerCount).toBe(500);
  });
});

describe("twitter snapshot writer (D-05 shares + raw components)", () => {
  it("[11-03] writeSnapshot UPSERTs twitter_posts and INSERTs a snapshot WITH share_count + raw retweet/quote/bookmark", async () => {
    const tweetId = `tweet_${uniq()}`;
    const accountId = `acct_${uniq()}`;
    await writeSnapshot({
      tweetId,
      accountId,
      mediaType: "video",
      caption: "a promo tweet",
      permalink: `https://x.com/h/status/${tweetId}`,
      thumbnailUrl: "https://pbs.twimg.com/cover.jpg",
      publishedAt: new Date("2026-06-01T12:00:00Z"),
      // shares = retweet(40) + quote(2) = 42 (the DERIVED sum the normalizer computes).
      metrics: { views: 100000, likes: 5000, comments: 200, shares: 42 },
      rawComponents: { retweetCount: 40, quoteCount: 2, bookmarkCount: 17 },
      status: "ok",
    });

    const [post] = await db.select().from(twitterPosts).where(eq(twitterPosts.tweetId, tweetId));
    expect(post).toBeDefined();
    expect(post!.accountId).toBe(accountId);
    expect(post!.mediaType).toBe("video");
    expect(post!.thumbnailUrl).toBe("https://pbs.twimg.com/cover.jpg");
    expect(post!.lastPollStatus).toBe("ok");

    const [snap] = await db
      .select()
      .from(twitterPostSnapshots)
      .where(eq(twitterPostSnapshots.tweetId, tweetId));
    expect(snap).toBeDefined();
    expect(snap!.viewCount).toBe(100000);
    expect(snap!.likeCount).toBe(5000);
    expect(snap!.commentCount).toBe(200);
    // The DERIVED shares sum (D-05).
    expect(snap!.shareCount).toBe(42);
    // The D-05 RAW components — retained so the split stays reconstructable + bookmarks never lost.
    expect(snap!.retweetCount).toBe(40);
    expect(snap!.quoteCount).toBe(2);
    expect(snap!.bookmarkCount).toBe(17);
  });

  it("[11-03] metrics are null-by-presence — a protected/limited tweet stores null, never 0", async () => {
    const tweetId = `tweet_${uniq()}`;
    await writeSnapshot({
      tweetId,
      mediaType: "text",
      // A protected/limited tweet may omit impressions + redistribution → null (not 0).
      metrics: { views: null, likes: 80, comments: 9, shares: null },
      rawComponents: { retweetCount: null, quoteCount: null, bookmarkCount: null },
      status: "ok",
    });

    const [snap] = await db
      .select()
      .from(twitterPostSnapshots)
      .where(eq(twitterPostSnapshots.tweetId, tweetId));
    expect(snap!.viewCount).toBeNull();
    expect(snap!.shareCount).toBeNull();
    expect(snap!.retweetCount).toBeNull();
    expect(snap!.quoteCount).toBeNull();
    expect(snap!.bookmarkCount).toBeNull();
    expect(snap!.likeCount).toBe(80);
  });

  it("[11-03] a non-ok poll updates polling state but writes NO snapshot row, and COALESCE-preserves the thumbnail", async () => {
    const tweetId = `tweet_${uniq()}`;
    await writeSnapshot({
      tweetId,
      mediaType: "video",
      thumbnailUrl: "https://pbs.twimg.com/good-cover.jpg",
      metrics: { views: 1, likes: 1, comments: 1, shares: 1 },
      rawComponents: { retweetCount: 1, quoteCount: 0, bookmarkCount: 0 },
      status: "ok",
    });
    // A failed refresh carries no metrics + no thumbnail.
    await writeSnapshot({ tweetId, metrics: null, status: "not_found" });

    const [post] = await db.select().from(twitterPosts).where(eq(twitterPosts.tweetId, tweetId));
    expect(post!.lastPollStatus).toBe("not_found");
    expect(post!.pollFailureCount).toBe(1);
    // The working thumbnail was PRESERVED (not blanked by the failed poll).
    expect(post!.thumbnailUrl).toBe("https://pbs.twimg.com/good-cover.jpg");

    // Exactly one snapshot (the ok poll); the not_found poll wrote none.
    const snaps = await db
      .select()
      .from(twitterPostSnapshots)
      .where(eq(twitterPostSnapshots.tweetId, tweetId));
    expect(snaps).toHaveLength(1);
  });
});

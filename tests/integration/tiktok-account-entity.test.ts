// TikTok account subject entity (CHECKLIST §1a) — tiktok_accounts is UPSERTed
// from the create-time profile resolve + the free feed owner object with NO extra
// credit, COALESCE-preserving prior good metadata on a partial parse, and keyed on
// the stable account_id (rename-proof, the Telegram channelKey lesson). It is OUR
// truth for the account's own upstream metadata, NOT a denorm of
// data_sources.display_name.
//
// Drives writeSnapshot (share_count stored — PLAT-02) + upsertTikTokAccount
// directly against real Postgres. The walker-driven feed-owner refresh is covered
// end-to-end in tiktok-walker.test.ts (Task 2); here we prove the storage layer:
// the rename-proof key, the handle_aliases append, the COALESCE-preserve on a
// partial feed refresh, and the share_count INSERT.
//
// Requirements: PLAT-02.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { ResolvedAccount } from "../../src/lib/sources/social-provider.js";

// Provider seam mock for the ADAPTER-PATH test (resolveHandleToAccountId): the
// provider's resolveAccount returns a ResolvedAccount carrying secUid, so we prove
// the create-time resolve THREADS sec_uid through to upsertTikTokAccount (not just
// the direct-upsert tests below). The DB is real.
let scriptedResolved: ResolvedAccount | null = null;
vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async resolveAccount(): Promise<ResolvedAccount | null> {
          return scriptedResolved;
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { tiktokAccounts, tiktokPosts, tiktokPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { writeSnapshot, upsertTikTokAccount } =
  await import("../../src/lib/sources/tiktok/server/snapshots.js");
const { tiktokAccountAdapterCore } =
  await import("../../src/lib/sources/tiktok/server/adapter.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function readAccount(accountId: string) {
  const [row] = await db
    .select()
    .from(tiktokAccounts)
    .where(eq(tiktokAccounts.accountId, accountId))
    .limit(1);
  return row;
}

describe("tiktok account subject entity (CHECKLIST §1a)", () => {
  it("[10-04] the create-time profile resolve UPSERTs tiktok_accounts keyed on account_id", async () => {
    const accountId = `acct_${uniq()}`;
    // Mirrors resolveHandleToAccountId passing the rich profile fields it already
    // paid for (nickname / avatar / follower_count / username / sec_uid).
    await upsertTikTokAccount({
      accountId,
      username: "stoolpresidente",
      nickname: "Dave Portnoy",
      avatarUrl: "https://cdn.tiktokcdn-us.com/avatar.jpeg",
      followerCount: 4_700_000,
      secUid: "MS4wLjABAAAA-secuid",
    });

    const row = await readAccount(accountId);
    expect(row).toBeDefined();
    // PK is the stable account_id (rename-proof), NOT the @handle.
    expect(row!.accountId).toBe(accountId);
    expect(row!.username).toBe("stoolpresidente");
    expect(row!.nickname).toBe("Dave Portnoy");
    expect(row!.avatarUrl).toBe("https://cdn.tiktokcdn-us.com/avatar.jpeg");
    expect(row!.followerCount).toBe(4_700_000);
    expect(row!.secUid).toBe("MS4wLjABAAAA-secuid");
    expect(row!.handleAliases).toEqual(["stoolpresidente"]);
    expect(row!.lastRefreshedAt).not.toBeNull();
  });

  it("[10-04] resolveHandleToAccountId threads sec_uid through to tiktok_accounts (C2 — adapter path)", async () => {
    const accountId = `acct_${uniq()}`;
    // The provider resolveAccount returns a ResolvedAccount carrying secUid (read off
    // the SAME profile response — no extra credit). The adapter must thread it into
    // upsertTikTokAccount; pre-fix normalizeProfile dropped sec_uid so it never landed.
    scriptedResolved = {
      accountId,
      displayName: "Adapter Path",
      username: "adapterpath",
      fullName: "Adapter Path",
      avatarUrl: "https://cdn/adapter.awebp",
      followerCount: 1234,
      secUid: "MS4wLjABAAAA-adapter-secuid",
    };

    const result = await tiktokAccountAdapterCore.resolveHandleToAccountId("adapterpath");
    expect(result).toEqual({ accountId, displayName: "Adapter Path" });

    const row = await readAccount(accountId);
    expect(row!.accountId).toBe(accountId);
    expect(row!.username).toBe("adapterpath");
    // The load-bearing assertion: sec_uid landed via the adapter path.
    expect(row!.secUid).toBe("MS4wLjABAAAA-adapter-secuid");
  });

  it("[10-04] the walker opportunistically refreshes username/avatar from the free feed owner (COALESCE-preserves the rich profile fields)", async () => {
    const accountId = `acct_${uniq()}`;
    // 1. The PAID profile resolve sets the rich fields (follower_count + nickname).
    await upsertTikTokAccount({
      accountId,
      username: "stoolpresidente",
      nickname: "Dave Portnoy",
      avatarUrl: "https://cdn/profile-avatar.jpeg",
      followerCount: 4_700_000,
      secUid: "MS4wLjABAAAA-secuid",
    });

    // 2. The FREE feed owner refresh carries account_id + username (+ a fresh
    //    avatar) but NO follower_count / nickname (the feed owner never has the
    //    richer fields). The COALESCE-preserve must keep them.
    await upsertTikTokAccount({
      accountId,
      username: "stoolpresidente",
      avatarUrl: "https://cdn/feed-avatar.awebp",
    });

    const row = await readAccount(accountId);
    // Feed owner avatar refreshed the (expiring) avatar.
    expect(row!.avatarUrl).toBe("https://cdn/feed-avatar.awebp");
    // follower_count + nickname + sec_uid PRESERVED from the profile call — the
    // cheap feed refresh (which has neither) did NOT blank them.
    expect(row!.followerCount).toBe(4_700_000);
    expect(row!.nickname).toBe("Dave Portnoy");
    expect(row!.secUid).toBe("MS4wLjABAAAA-secuid");
  });

  it("[10-04] a changed @handle appends the old value to handle_aliases (rename history) — same account_id key", async () => {
    const accountId = `acct_${uniq()}`;
    await upsertTikTokAccount({
      accountId,
      username: "oldhandle",
      nickname: "Old",
      followerCount: 100,
    });
    const first = await readAccount(accountId);
    expect(first!.username).toBe("oldhandle");
    const firstSeen = first!.firstSeenAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    // Rename: SAME account_id (rename-proof key), new handle + grown follower count.
    await upsertTikTokAccount({
      accountId,
      username: "newhandle",
      nickname: "New",
      followerCount: 250,
    });

    const second = await readAccount(accountId);
    // Same row (keyed on account_id), updated handle + count.
    expect(second!.accountId).toBe(accountId);
    expect(second!.username).toBe("newhandle");
    expect(second!.nickname).toBe("New");
    expect(second!.followerCount).toBe(250);
    // Both handles retained; first_seen unchanged (it is the same entity).
    expect(second!.handleAliases.sort()).toEqual(["newhandle", "oldhandle"]);
    expect(second!.firstSeenAt.getTime()).toBe(firstSeen);
    // A re-write of the SAME handle does NOT grow handle_aliases (no duplicate).
    await upsertTikTokAccount({ accountId, username: "newhandle" });
    const third = await readAccount(accountId);
    expect(third!.handleAliases.sort()).toEqual(["newhandle", "oldhandle"]);
  });

  it("[10-04] a partial parse COALESCE-preserves prior good nickname/avatar (no blanking)", async () => {
    const accountId = `acct_${uniq()}`;
    await upsertTikTokAccount({
      accountId,
      username: "handle",
      nickname: "Good Name",
      avatarUrl: "https://cdn/good.awebp",
      followerCount: 500,
    });
    // A transient miss: all rich fields null (only the key + a null parse).
    await upsertTikTokAccount({
      accountId,
      username: null,
      nickname: null,
      avatarUrl: null,
      followerCount: null,
    });

    const row = await readAccount(accountId);
    expect(row!.username).toBe("handle");
    expect(row!.nickname).toBe("Good Name");
    expect(row!.avatarUrl).toBe("https://cdn/good.awebp");
    expect(row!.followerCount).toBe(500);
  });
});

describe("tiktok snapshot writer (PLAT-02 share_count)", () => {
  it("[10-04] writeSnapshot UPSERTs tiktok_posts and INSERTs a snapshot WITH share_count for a short", async () => {
    const awemeId = `aweme_${uniq()}`;
    const accountId = `acct_${uniq()}`;
    await writeSnapshot({
      awemeId,
      accountId,
      // Every TikTok video → "short" media_type (user re-decided 2026-06-12).
      mediaType: "short",
      caption: "a tiktok video",
      permalink: `https://www.tiktok.com/@h/video/${awemeId}`,
      thumbnailUrl: "https://cdn.tiktokcdn-us.com/cover.awebp",
      publishedAt: new Date("2026-06-01T12:00:00Z"),
      metrics: { views: 100000, likes: 5000, comments: 200, shares: 4974 },
      status: "ok",
    });

    const [post] = await db.select().from(tiktokPosts).where(eq(tiktokPosts.awemeId, awemeId));
    expect(post).toBeDefined();
    expect(post!.accountId).toBe(accountId);
    expect(post!.mediaType).toBe("short");
    expect(post!.thumbnailUrl).toBe("https://cdn.tiktokcdn-us.com/cover.awebp");
    expect(post!.lastPollStatus).toBe("ok");

    const [snap] = await db
      .select()
      .from(tiktokPostSnapshots)
      .where(eq(tiktokPostSnapshots.awemeId, awemeId));
    expect(snap).toBeDefined();
    expect(snap!.viewCount).toBe(100000);
    expect(snap!.likeCount).toBe(5000);
    expect(snap!.commentCount).toBe(200);
    // The PLAT-02 delta — the share metric IG never had.
    expect(snap!.shareCount).toBe(4974);
  });

  it("[10-04] share_count is null-by-presence — a photo-mode post with no shares stores null, never 0", async () => {
    const awemeId = `aweme_${uniq()}`;
    await writeSnapshot({
      awemeId,
      mediaType: "carousel",
      // Photo-mode: no views, no shares surfaced → null (not 0).
      metrics: { views: null, likes: 80, comments: 9, shares: null },
      status: "ok",
    });

    const [snap] = await db
      .select()
      .from(tiktokPostSnapshots)
      .where(eq(tiktokPostSnapshots.awemeId, awemeId));
    expect(snap!.viewCount).toBeNull();
    expect(snap!.shareCount).toBeNull();
    expect(snap!.likeCount).toBe(80);
  });

  it("[10-04] a non-ok poll updates polling state but writes NO snapshot row, and COALESCE-preserves the thumbnail", async () => {
    const awemeId = `aweme_${uniq()}`;
    await writeSnapshot({
      awemeId,
      mediaType: "short",
      thumbnailUrl: "https://cdn/good-cover.awebp",
      metrics: { views: 1, likes: 1, comments: 1, shares: 1 },
      status: "ok",
    });
    // A failed refresh carries no metrics + no thumbnail.
    await writeSnapshot({ awemeId, metrics: null, status: "not_found" });

    const [post] = await db.select().from(tiktokPosts).where(eq(tiktokPosts.awemeId, awemeId));
    expect(post!.lastPollStatus).toBe("not_found");
    expect(post!.pollFailureCount).toBe(1);
    // The working thumbnail was PRESERVED (not blanked by the failed poll).
    expect(post!.thumbnailUrl).toBe("https://cdn/good-cover.awebp");

    // Exactly one snapshot (the ok poll); the not_found poll wrote none.
    const snaps = await db
      .select()
      .from(tiktokPostSnapshots)
      .where(eq(tiktokPostSnapshots.awemeId, awemeId));
    expect(snaps).toHaveLength(1);
  });
});

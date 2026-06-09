// instagram_accounts — the account subject entity (mirrors telegram_channels /
// youtube_channels). Populated from data ALREADY fetched, with ZERO additional
// provider credits:
//   - the PAID create-time profile resolve (resolveHandleToAccountId) → the
//     richer fields (full_name / avatar / follower_count / username).
//   - the FREE feed owner object the walker page already carries → account_id +
//     username (+ avatar), COALESCE-preserving the richer profile fields.
//
// Real Postgres; the ScrapeCreators boundary is faked at the PROVIDER SEAM (a
// controllable fake SocialProvider via vi.mock of provider/registry), NEVER the
// DB. The fake's resolveAccount + fetchPosts return the cross-platform shapes the
// real provider would — the entity-population code under test is the adapter +
// walker, not the vendor parse (that is covered by the normalizer unit test).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage, ResolvedAccount } from "../../src/lib/sources/social-provider.js";

// Scripted provider state. `resolveResult` controls the next resolveAccount
// return; `pages` feeds fetchPosts per feed. `calls` records EVERY provider HTTP
// to assert the entity populate rides existing calls (no extra credit).
interface ScriptedProvider {
  resolveResult: ResolvedAccount | null;
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
  calls: Array<{ method: "resolveAccount" | "fetchPosts"; feed?: "posts" | "reels" }>;
}

const provider: ScriptedProvider = {
  resolveResult: null,
  pages: { posts: [], reels: [] },
  calls: [],
};

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null };
}

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(
          _platform: string,
          _handle: string,
          _cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          const feed = opts.kindFilter ?? "posts";
          provider.calls.push({ method: "fetchPosts", feed });
          const next = provider.pages[feed].shift();
          return next ?? emptyPage();
        },
        async resolveAccount(): Promise<ResolvedAccount | null> {
          provider.calls.push({ method: "resolveAccount" });
          return provider.resolveResult;
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { instagramAccounts } = await import("../../src/lib/server/db/schema/index.js");
const { instagramPosts } = await import("../../src/lib/server/db/schema/index.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { instagramAccountAdapterCore } =
  await import("../../src/lib/sources/instagram/server/adapter.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");

const ACCOUNT = "acct-entity";

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "image" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: null, likes: 10, comments: 2, shares: null },
    caption: `caption ${id}`,
    thumbnailUrl: `https://cdn/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

async function seedSource(account = ACCOUNT): Promise<string> {
  const user = await seedUserDirectly({
    email: `entity-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/entityacct/",
      channelId: account,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "entityacct", accountId: account },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

async function readAccount(accountId = ACCOUNT) {
  const [row] = await db
    .select()
    .from(instagramAccounts)
    .where(eq(instagramAccounts.accountId, accountId))
    .limit(1);
  return row;
}

beforeEach(() => {
  provider.resolveResult = null;
  provider.pages = { posts: [], reels: [] };
  provider.calls = [];
});

describe("instagram_accounts — populated from the PAID profile resolve (no extra fetch)", () => {
  it("resolveHandleToAccountId UPSERTs the rich entity fields off the profile response", async () => {
    provider.resolveResult = {
      accountId: ACCOUNT,
      displayName: "Entity Account",
      username: "entityacct",
      fullName: "Entity Account",
      avatarUrl: "https://cdn/avatar.jpg",
      followerCount: 12345,
    };

    const resolved = await instagramAccountAdapterCore.resolveHandleToAccountId("entityacct");
    expect(resolved).not.toBeNull();
    expect(resolved!.accountId).toBe(ACCOUNT);

    const row = await readAccount();
    expect(row).toBeDefined();
    expect(row!.username).toBe("entityacct");
    expect(row!.fullName).toBe("Entity Account");
    expect(row!.avatarUrl).toBe("https://cdn/avatar.jpg");
    expect(row!.followerCount).toBe(12345);
    expect(row!.handleAliases).toEqual(["entityacct"]);
    expect(row!.lastRefreshedAt).not.toBeNull();

    // Exactly ONE provider call (the resolve) — the entity UPSERT rode it.
    expect(provider.calls).toEqual([{ method: "resolveAccount" }]);
  });

  it("a second resolve refreshes last_refreshed_at and appends a renamed handle to handle_aliases", async () => {
    provider.resolveResult = {
      accountId: ACCOUNT,
      displayName: "Old Name",
      username: "oldhandle",
      fullName: "Old Name",
      avatarUrl: "https://cdn/old.jpg",
      followerCount: 100,
    };
    await instagramAccountAdapterCore.resolveHandleToAccountId("oldhandle");
    const first = await readAccount();
    expect(first!.username).toBe("oldhandle");
    const firstRefreshed = first!.lastRefreshedAt!.getTime();

    // Rename: same account_id, new handle + grown follower count.
    provider.resolveResult = {
      accountId: ACCOUNT,
      displayName: "New Name",
      username: "newhandle",
      fullName: "New Name",
      avatarUrl: "https://cdn/new.jpg",
      followerCount: 250,
    };
    await new Promise((r) => setTimeout(r, 5));
    await instagramAccountAdapterCore.resolveHandleToAccountId("newhandle");

    const second = await readAccount();
    expect(second!.username).toBe("newhandle");
    expect(second!.fullName).toBe("New Name");
    expect(second!.followerCount).toBe(250);
    // Both handles retained; first_seen unchanged; last_refreshed advanced.
    expect(second!.handleAliases.sort()).toEqual(["newhandle", "oldhandle"]);
    expect(second!.firstSeenAt.getTime()).toBe(first!.firstSeenAt.getTime());
    expect(second!.lastRefreshedAt!.getTime()).toBeGreaterThanOrEqual(firstRefreshed);
  });
});

describe("instagram_accounts — populated from the FREE feed owner (no extra fetch)", () => {
  it("the walker UPSERTs account_id + username (+ avatar) from the feed owner, COALESCE-preserving the rich profile fields", async () => {
    await seedSource();
    // First, the PAID resolve sets the rich fields (avatar + follower count).
    provider.resolveResult = {
      accountId: ACCOUNT,
      displayName: "Entity",
      username: "entityacct",
      fullName: "Entity Full",
      avatarUrl: "https://cdn/profile-avatar.jpg",
      followerCount: 9000,
    };
    await instagramAccountAdapterCore.resolveHandleToAccountId("entityacct");
    provider.calls = [];

    // The FREE feed page carries the owner but NO follower_count (the feed owner
    // never has it). A username refresh + an owner avatar arrive; the richer
    // follower_count must be COALESCE-preserved from the profile call.
    provider.pages.posts = [
      {
        posts: [post("e1", 1), post("e2", 2)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
        owner: {
          accountId: ACCOUNT,
          username: "entityacct",
          avatarUrl: "https://cdn/feed-avatar.jpg",
        },
      },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const row = await readAccount();
    expect(row!.username).toBe("entityacct");
    // Feed owner avatar refreshed the (expiring) avatar.
    expect(row!.avatarUrl).toBe("https://cdn/feed-avatar.jpg");
    // follower_count + full_name PRESERVED from the profile call — the cheap feed
    // refresh (which has neither) did NOT blank them.
    expect(row!.followerCount).toBe(9000);
    expect(row!.fullName).toBe("Entity Full");

    // The walk made ONLY the two feed calls (posts + reels) — NO extra
    // resolveAccount / profile fetch was introduced to populate the entity.
    expect(provider.calls).toEqual([
      { method: "fetchPosts", feed: "posts" },
      { method: "fetchPosts", feed: "reels" },
    ]);
  });

  it("account_id linkage: instagram_posts.account_id matches instagram_accounts.account_id", async () => {
    await seedSource();
    provider.pages.posts = [
      {
        posts: [post("link1", 1)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
        owner: { accountId: ACCOUNT, username: "entityacct", avatarUrl: null },
      },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const acct = await readAccount();
    expect(acct).toBeDefined();
    const [postRow] = await db
      .select()
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, "link1"))
      .limit(1);
    expect(postRow!.accountId).toBe(acct!.accountId);
  });

  it("a missing feed owner does NOT create or blank an account row (no anchor)", async () => {
    await seedSource();
    provider.pages.posts = [
      {
        posts: [post("noowner", 1)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
        owner: null,
      },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    // No owner on the page → no entity row written by the walk.
    const row = await readAccount();
    expect(row).toBeUndefined();
  });
});

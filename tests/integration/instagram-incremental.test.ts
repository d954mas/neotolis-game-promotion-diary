// IG incremental refresh after backfill_complete (BACK-03).
//
// Once an account is fully walked (backfill_complete=true), ongoing refresh
// fetches ONLY new posts since the frontier + re-polls active posts' metrics —
// it does NOT walk deeper into history. REAL handleBackfillAccount against real
// Postgres; provider seam mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

const provider = {
  pages: { posts: [] as ProviderPage[], reels: [] as ProviderPage[] },
  calls: [] as Array<{ feed: "posts" | "reels"; cursor: string | null }>,
};

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
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
          cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          const feed = opts.kindFilter ?? "posts";
          provider.calls.push({ feed, cursor });
          return provider.pages[feed].shift() ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-incr", displayName: "Incr" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { instagramPostSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");
const { getInstagramBackfillState } =
  await import("../../src/lib/sources/instagram/server/backfill-state.js");

const ACCOUNT = "acct-incr";

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "image" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: null, likes: 5, comments: 1, shares: null },
    caption: id,
    thumbnailUrl: null,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

async function seedCompletedSource(frontier: Date): Promise<string> {
  const user = await seedUserDirectly({
    email: `incr-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/incracct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "incracct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  // Mark the account fully backfilled with a frontier at `frontier`.
  await db.insert(dataSourceChannelState).values({
    kind: "instagram_account",
    channelKey: ACCOUNT,
    lastPolledAt: new Date(Date.now() - 86_400_000),
    backfillOldestAt: frontier,
    backfillComplete: true,
    metadata: {
      instagram: {
        posts: { cursor: null, complete: true },
        reels: { cursor: null, complete: true },
        collected: 30,
      },
    },
  });
  return row!.id;
}

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
  provider.calls = [];
});

describe("instagram incremental refresh (post-backfill_complete)", () => {
  it("fetches only new posts since the frontier and does NOT walk deeper", async () => {
    // Frontier = 60 days ago (everything older is already imported).
    const frontier = new Date(Date.now() - 60 * 86_400_000);
    await seedCompletedSource(frontier);

    // The incremental tick fetches page 1: one NEW post (1d ago, newer than the
    // frontier) followed by an OLD post (90d ago, older than the frontier) the
    // walker must NOT import (no deeper walk). nextCursor non-null to prove the
    // walker does not chase it deeper once it crosses the frontier.
    provider.pages.posts = [
      {
        posts: [post("new1", 1), post("old1", 90)],
        nextCursor: "DEEPER",
        endOfFeed: false,
        creditsUsed: 1,
      },
    ];
    provider.pages.reels = [emptyPage()];

    // Incremental refresh — target shallow (epoch). exhausted branch ⇒
    // since = frontier ⇒ only > frontier collected.
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
        triggerUserId: undefined,
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "instagram_post"));
    expect(imported.map((e) => e.externalId)).toEqual(["new1"]);
    // old1 (older than the frontier) was NOT imported — no deeper walk.
    expect(imported.some((e) => e.externalId === "old1")).toBe(false);

    // The posts call started at page 1 (cursor null), proving the exhausted
    // branch resets to page 1 rather than resuming a historical cursor.
    expect(provider.calls.find((c) => c.feed === "posts")?.cursor).toBeNull();

    // A fresh snapshot was written for the re-polled new post (re-poll active).
    const snaps = await db
      .select()
      .from(instagramPostSnapshots)
      .where(eq(instagramPostSnapshots.postId, "new1"));
    expect(snaps.length).toBeGreaterThan(0);

    // The channel frontier did NOT regress and stays complete.
    const [cs] = await db
      .select()
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "instagram_account"),
          eq(dataSourceChannelState.channelKey, ACCOUNT),
        ),
      )
      .limit(1);
    expect(cs?.backfillComplete).toBe(true);
    expect(cs?.backfillOldestAt?.getTime()).toBe(frontier.getTime());

    // The incremental sub-state did not deepen the historical cursor.
    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.posts.complete).toBe(true);
  });
});

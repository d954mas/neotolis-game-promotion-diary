// TikTok incremental catch-up — once an account is fully walked
// (backfill_complete=true), ongoing refresh fetches ONLY new posts since the
// frontier + re-polls active posts' metrics — it does NOT walk deeper. REAL
// handleBackfillAccount against real Postgres; provider seam mocked.
//
// Requirements: PLAT-02.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

const provider = {
  pages: [] as ProviderPage[],
  calls: [] as Array<{ cursor: string | null }>,
};

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null };
}

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(_p: string, _h: string, cursor: string | null): Promise<ProviderPage> {
          provider.calls.push({ cursor });
          return provider.pages.shift() ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-incr-tk", displayName: "Incr" };
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
const { tiktokPostSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { getTikTokBackfillState } =
  await import("../../src/lib/sources/tiktok/server/backfill-state.js");

const ACCOUNT = "acct-incr-tk";

function post(id: string, daysAgo: number) {
  return {
    id,
    // Every TikTok video → "short" (user re-decided 2026-06-12).
    kind: "short" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: 50, likes: 5, comments: 1, shares: 3 },
    caption: id,
    thumbnailUrl: null,
    permalink: `https://www.tiktok.com/@i/video/${id}`,
  };
}

async function seedCompletedSource(frontier: Date): Promise<string> {
  const user = await seedUserDirectly({
    email: `incr-tk-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@incracct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "incracct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  // Mark the account fully backfilled with a frontier at `frontier`.
  await db.insert(dataSourceChannelState).values({
    kind: "tiktok_account",
    channelKey: ACCOUNT,
    lastPolledAt: new Date(Date.now() - 86_400_000),
    backfillOldestAt: frontier,
    backfillComplete: true,
    metadata: {
      tiktok: { cursor: null, complete: true, collected: 30, operatorPaused: false },
    },
  });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
  provider.calls = [];
});

describe("tiktok incremental catch-up (post-backfill_complete)", () => {
  it("[10-04] a follow-up tick imports only posts newer than the persisted frontier (no deeper walk)", async () => {
    const frontier = new Date(Date.now() - 60 * 86_400_000);
    await seedCompletedSource(frontier);

    // page 1: one NEW post (1d ago, newer than the frontier) followed by an OLD
    // post (90d ago) the walker must NOT import. nextCursor non-null to prove the
    // walker does not chase it deeper once it crosses the frontier.
    provider.pages = [
      {
        posts: [post("new1", 1), post("old1", 90)],
        nextCursor: "DEEPER",
        endOfFeed: false,
        creditsUsed: 1,
        owner: null,
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
        triggerUserId: undefined,
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(imported.map((e) => e.externalId)).toEqual(["new1"]);
    expect(imported.some((e) => e.externalId === "old1")).toBe(false);

    // The call started at page 1 (cursor null), proving the exhausted branch resets
    // to page 1 rather than resuming a historical cursor.
    expect(provider.calls[0]?.cursor).toBeNull();

    // A fresh snapshot was written for the re-polled new post (re-poll active).
    const snaps = await db
      .select()
      .from(tiktokPostSnapshots)
      .where(eq(tiktokPostSnapshots.awemeId, "new1"));
    expect(snaps.length).toBeGreaterThan(0);

    // The channel frontier did NOT regress and stays complete.
    const [cs] = await db
      .select()
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "tiktok_account"),
          eq(dataSourceChannelState.channelKey, ACCOUNT),
        ),
      )
      .limit(1);
    expect(cs?.backfillComplete).toBe(true);
    expect(cs?.backfillOldestAt?.getTime()).toBe(frontier.getTime());

    const st = await getTikTokBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
  });

  it("[10-04] re-importing an already-seen aweme id is idempotent (no duplicate event)", async () => {
    const frontier = new Date(Date.now() - 60 * 86_400_000);
    await seedCompletedSource(frontier);

    // Tick 1 imports new1.
    provider.pages = [
      { posts: [post("dup1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    ];
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    // Tick 2 returns the SAME aweme id — must NOT create a duplicate event.
    provider.pages = [
      { posts: [post("dup1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    ];
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const imported = await db.select().from(events).where(eq(events.externalId, "dup1"));
    expect(imported).toHaveLength(1);
  });
});

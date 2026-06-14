// TikTok backfill bound — the single-feed walker stops at SOCIAL_BACKFILL_MAX_POSTS
// OR the date window, whichever first, so cost is independent of archive size
// (BACK-01). REAL handleBackfillAccount against real Postgres; provider seam mocked.
//
// Requirements: PLAT-02.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

const provider = { pages: [] as ProviderPage[] };

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
        async fetchPosts(): Promise<ProviderPage> {
          return provider.pages.shift() ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-bound-tk", displayName: "Bound" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { env } = await import("../../src/lib/server/config/env.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { getTikTokBackfillState } =
  await import("../../src/lib/sources/tiktok/server/backfill-state.js");
const { getChannelState } = await import("../../src/lib/server/services/channel-state.js");
const { tiktokAdapter } = await import("../../src/lib/sources/tiktok/server/index.js");
const { outbox } = await import("../../src/lib/server/db/schema/outbox.js");

const ACCOUNT = "acct-bound-tk";
const envMut = env as { SOCIAL_BACKFILL_MAX_POSTS: number };
let originalMaxPosts: number;

function post(id: string, daysAgo: number) {
  return {
    id,
    // Every TikTok video → "short" (user re-decided 2026-06-12).
    kind: "short" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: 1, likes: 1, comments: 1, shares: 1 },
    caption: id,
    thumbnailUrl: null,
    permalink: `https://www.tiktok.com/@b/video/${id}`,
  };
}

/** A "still more available" page of 12 fresh posts (all within 1d). */
function fullPage(seed: number): ProviderPage {
  const posts = Array.from({ length: 12 }, (_, i) => post(`c${seed}_${i}`, 1));
  return { posts, nextCursor: `CURSOR_${seed}`, endOfFeed: false, creditsUsed: 1, owner: null };
}

async function seedSource(): Promise<string> {
  const user = await seedUserDirectly({
    email: `bound-tk-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@boundacct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "boundacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
  originalMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
});
afterEach(() => {
  envMut.SOCIAL_BACKFILL_MAX_POSTS = originalMaxPosts;
});

describe("tiktok backfill bounding (BACK-01)", () => {
  it("[10-04] walks one feed bounded by SOCIAL_BACKFILL_MAX_POSTS (stops at the cap)", async () => {
    envMut.SOCIAL_BACKFILL_MAX_POSTS = 24;
    await seedSource();

    // The provider ALWAYS returns a full 12-post page with a non-null cursor
    // (more_available forever). With cap=24 the deep walk must halt after 24 posts.
    provider.pages = [fullPage(1), fullPage(2), fullPage(3), fullPage(4)];

    for (let tick = 0; tick < 4; tick++) {
      const st = await getTikTokBackfillState(ACCOUNT);
      if (st.complete) break;
      await handleBackfillAccount({
        data: {
          kind: "tiktok_account",
          channelKey: ACCOUNT,
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "initial",
        },
      });
    }

    const st = await getTikTokBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
    expect(st.collected).toBe(24); // exactly the cap — not more

    const imported = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(imported.length).toBe(24);
  });

  it("[10-04] stops at the backfill date window when it is reached before the post cap", async () => {
    // cap stays at the default so the WINDOW is the binding bound.
    await seedSource();

    // Newest-first: two posts inside 7d, then one beyond — stop at the boundary.
    provider.pages = [
      {
        posts: [post("w1", 1), post("w2", 5), post("w3", 30)],
        nextCursor: "MORE",
        endOfFeed: false,
        creditsUsed: 1,
        owner: null,
      },
    ];

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: sevenDaysAgo,
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(imported.map((e) => e.externalId).sort()).toEqual(["w1", "w2"]);
    // Crossing the window completes the feed.
    const st = await getTikTokBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
  });
});

// ── P1-A (twin of the twitter fix): an all-older-than-window first deep page must still
//    write a NON-null frontier so a later WIDEN can reopen the history.
describe("tiktok backfill frontier on out-of-window first page (widen reopen)", () => {
  async function seedSourceFor(account: string): Promise<string> {
    const user = await seedUserDirectly({
      email: `frontier-tk-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const [row] = await db
      .insert(dataSources)
      .values({
        userId: user.id,
        kind: "tiktok_account",
        handleUrl: `https://www.tiktok.com/@${account}`,
        channelId: account,
        isOwnedByMe: true,
        autoImport: true,
        metadata: { handle: account, accountId: account },
      })
      .returning({ id: dataSources.id });
    return row!.id;
  }

  it("[10-P1A] a deep first page entirely older than the window records a non-null frontier and a widen reopens it", async () => {
    const account = `acct-frontier-tk-${Math.random().toString(36).slice(2)}`;
    const sourceId = await seedSourceFor(account);

    // The ONLY page is all-older-than-window AND end-of-feed → zero feed events.
    provider.pages = [
      {
        posts: [post("o1", 30), post("o2", 45), post("o3", 60)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
        owner: null,
      },
    ];

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: account,
        depthBoundIso: sevenDaysAgo.toISOString(),
        flow: "initial",
        forceDeep: true,
      },
    });

    const importedByExt = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(
      importedByExt.filter((e) => ["o1", "o2", "o3"].includes(e.externalId ?? "")).length,
    ).toBe(0);

    // Frontier = o1 @ 30d: the loop breaks at the FIRST out-of-window post (newest-first),
    // so o1 is the oldest post fetched-and-snapshotted before the break.
    const state = await getChannelState("tiktok_account", account);
    expect(state?.backfillComplete).toBe(true);
    expect(
      state?.backfillOldestAt,
      "frontier must be non-null after an all-older page",
    ).not.toBeNull();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    expect(Math.abs(state!.backfillOldestAt!.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(
      86_400_000,
    );

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await db.transaction(async (tx) => {
      await tiktokAdapter.resetWalkerStateOnWidening!(
        {
          id: sourceId,
          userId: "ignored",
          kind: "tiktok_account",
          channelId: account,
          autoImport: true,
          isOwnedByMe: true,
          backfillTargetSince: ninetyDaysAgo,
          metadata: { accountId: account, handle: account },
        } as never,
        {
          previousTarget: sevenDaysAgo,
          newTarget: ninetyDaysAgo,
          triggerUserId: "widen-user",
          ipAddress: "0.0.0.0",
          tx,
        },
      );
    });

    const rows = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(eq(outbox.queue, "tiktok.backfill.account"));
    const reopen = rows.find(
      (r) =>
        (r.payload as { channelKey?: string }).channelKey === account &&
        (r.payload as { forceDeep?: boolean }).forceDeep === true,
    );
    expect(
      reopen,
      "widen must re-enqueue a forceDeep walk (not early-exit on null frontier)",
    ).toBeTruthy();
  });
});

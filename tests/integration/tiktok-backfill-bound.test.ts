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

// IG backfill bounding — post-count cap + date window (BACK-01).
//
// The walker's cost is independent of archive size: the historical (deep) walk
// stops at SOCIAL_BACKFILL_MAX_POSTS OR the date window, whichever is hit first.
// REAL handleBackfillAccount against real Postgres; provider seam mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

const provider = { pages: { posts: [] as ProviderPage[], reels: [] as ProviderPage[] } };

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
          _cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          const feed = opts.kindFilter ?? "posts";
          return provider.pages[feed].shift() ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-bound", displayName: "Bound" };
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
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");
const { getInstagramBackfillState } =
  await import("../../src/lib/sources/instagram/server/backfill-state.js");

const ACCOUNT = "acct-bound";
const envMut = env as { SOCIAL_BACKFILL_MAX_POSTS: number };
let originalMaxPosts: number;

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "image" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: null, likes: 1, comments: 1, shares: null },
    caption: id,
    thumbnailUrl: null,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

/** A "still more available" posts page of 12 fresh posts (all within 1y). */
function fullPage(seed: number): ProviderPage {
  const posts = Array.from({ length: 12 }, (_, i) => post(`c${seed}_${i}`, 1));
  return { posts, nextCursor: `CURSOR_${seed}`, endOfFeed: false, creditsUsed: 1 };
}

async function seedSource(): Promise<string> {
  const user = await seedUserDirectly({
    email: `bound-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/boundacct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "boundacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
  originalMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
});
afterEach(() => {
  envMut.SOCIAL_BACKFILL_MAX_POSTS = originalMaxPosts;
});

describe("instagram backfill bounding (post-count cap + date window)", () => {
  it("walker stops at SOCIAL_BACKFILL_MAX_POSTS cap even though more_available stays true", async () => {
    envMut.SOCIAL_BACKFILL_MAX_POSTS = 24;
    await seedSource();

    // The provider ALWAYS returns a full 12-post page with a non-null cursor
    // (more_available=true forever). Reels empty. With cap=24 the deep walk must
    // halt after collecting 24 posts (2 ticks of 12).
    provider.pages.posts = [fullPage(1), fullPage(2), fullPage(3), fullPage(4)];
    provider.pages.reels = [emptyPage()];

    // Tick 1 (collects 12) + Tick 2 (collects 24 → cap → complete).
    for (let tick = 0; tick < 4; tick++) {
      const st = await getInstagramBackfillState(ACCOUNT);
      if (st.posts.complete && st.reels.complete) break;
      await handleBackfillAccount({
        data: {
          kind: "instagram_account",
          channelKey: ACCOUNT,
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "initial",
        },
      });
    }

    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.posts.complete).toBe(true);
    expect(st.collected).toBe(24); // exactly the cap — not more

    const imported = await db.select().from(events).where(eq(events.kind, "instagram_post"));
    expect(imported.length).toBe(24);
  });

  it("walker stops at the date window when it is the tighter bound", async () => {
    // cap stays at the default (48) so the WINDOW is the binding bound.
    await seedSource();

    // A 7-day window. The page is newest-first: two posts inside 7d, then one
    // beyond — the walk must stop at the boundary and import only the 2 inside.
    provider.pages.posts = [
      {
        posts: [post("w1", 1), post("w2", 5), post("w3", 30)],
        nextCursor: "MORE",
        endOfFeed: false,
        creditsUsed: 1,
      },
    ];
    provider.pages.reels = [emptyPage()];

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: sevenDaysAgo,
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "instagram_post"));
    expect(imported.map((e) => e.externalId).sort()).toEqual(["w1", "w2"]);
    // Crossing the window completes the posts feed (we deliberately stopped).
    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.posts.complete).toBe(true);
  });
});

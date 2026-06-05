// IG account walker — resumable, cursor-persisted (BACK-02, PLAT-01, Pitfall 4).
//
// Drives the REAL handleBackfillAccount against real Postgres; the ScrapeCreators
// boundary is faked at the PROVIDER SEAM (vi.mock of provider/registry's
// getSocialProvider → a controllable fake SocialProvider), NEVER the DB. The
// uniform ProviderPage hides the posts(next_max_id)/reels(paging_info.max_id)
// cursor divergence (Plan 02), so the walker only ever sees nextCursor.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

// Per-feed scripted pages. Keyed "posts"/"reels"; each call shifts the next
// page off the queue. The fake provider reserves NO credits (it bypasses the
// HTTP seam) — budget wiring is covered by social-budget-throttle + http.ts.
interface ScriptedProvider {
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
  calls: Array<{ feed: "posts" | "reels"; cursor: string | null }>;
}

const provider: ScriptedProvider = { pages: { posts: [], reels: [] }, calls: [] };

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
          const next = provider.pages[feed].shift();
          return next ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-test", displayName: "Test" };
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
const { instagramPosts } = await import("../../src/lib/server/db/schema/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");
const { getInstagramBackfillState } =
  await import("../../src/lib/sources/instagram/server/backfill-state.js");

const ACCOUNT = "acct-walker";

function post(id: string, daysAgo: number, kind: "image" | "video" = "image") {
  return {
    id,
    kind,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: kind === "video" ? 100 : null, likes: 10, comments: 2, shares: null },
    caption: `caption ${id}`,
    thumbnailUrl: `https://cdn/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

async function seedSource(opts: { autoImport?: boolean } = {}): Promise<string> {
  const user = await seedUserDirectly({ email: `walker-${Math.random().toString(36).slice(2)}@t.io` });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/walkeracct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: opts.autoImport ?? true,
      metadata: { handle: "walkeracct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

async function readChannelState() {
  const [row] = await db
    .select()
    .from(dataSourceChannelState)
    .where(
      and(
        eq(dataSourceChannelState.kind, "instagram_account"),
        eq(dataSourceChannelState.channelKey, ACCOUNT),
      ),
    )
    .limit(1);
  return row;
}

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
  provider.calls = [];
});

describe("instagram account walker (resumable, cursor-persisted)", () => {
  it("posts endpoint paginates via the uniform cursor and persists it to data_source_channel_state.metadata between ticks", async () => {
    await seedSource();
    // Tick 1: posts page with a cursor (more_available); reels empty (ends).
    provider.pages.posts = [
      { posts: [post("p1", 1), post("p2", 2)], nextCursor: "CURSOR_A", endOfFeed: false, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const st1 = await getInstagramBackfillState(ACCOUNT);
    expect(st1.posts.cursor).toBe("CURSOR_A");
    expect(st1.posts.complete).toBe(false);
    expect(st1.reels.complete).toBe(true);

    // Tick 2 resumes from the persisted cursor.
    provider.pages.posts = [
      { posts: [post("p3", 3)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = []; // reels already complete — walker skips it
    provider.calls = [];

    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    // Second tick passed the stored cursor back to the provider's posts feed.
    const postsCall = provider.calls.find((c) => c.feed === "posts");
    expect(postsCall?.cursor).toBe("CURSOR_A");
    // Reels feed was already complete — not re-fetched.
    expect(provider.calls.some((c) => c.feed === "reels")).toBe(false);

    const inserted = await db.select().from(events).where(eq(events.kind, "instagram_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("reels feed paginates via its own cursor and backfill_complete is set only when BOTH feeds end", async () => {
    await seedSource();
    // Posts ends immediately; reels has a cursor (still going).
    provider.pages.posts = [emptyPage()];
    provider.pages.reels = [
      { posts: [post("r1", 1, "video")], nextCursor: "REEL_CURSOR", endOfFeed: false, creditsUsed: 1 },
    ];

    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    // Posts ended but reels still has a cursor → account NOT complete.
    let cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.posts.complete).toBe(true);
    expect(st.reels.cursor).toBe("REEL_CURSOR");
    expect(st.reels.complete).toBe(false);

    // Next tick: reels ends → BOTH feeds complete → account complete.
    provider.pages.posts = [];
    provider.pages.reels = [
      { posts: [post("r2", 2, "video")], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);
  });

  it("writes snapshots (instagram_posts cache rows) for each fetched post", async () => {
    await seedSource();
    provider.pages.posts = [
      { posts: [post("s1", 1), post("s2", 2)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const cached = await db.select().from(instagramPosts);
    expect(cached.map((p) => p.postId).sort()).toEqual(["s1", "s2"]);
    // accountId persisted from the source metadata.
    expect(cached.every((p) => p.accountId === ACCOUNT)).toBe(true);
  });

  it("a missing-handle first page (empty, no cursor) flips the source to not_found, NOT backfill_complete (Pitfall 4)", async () => {
    const sourceId = await seedSource();
    // Brand-new source: both feeds return an empty first page with no cursor.
    provider.pages.posts = [emptyPage()];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: { kind: "instagram_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const [src] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
    expect(src?.needsReconnect).toBe(true);
    expect(src?.lastErrorKind).toBe("not-found");

    const cs = await readChannelState();
    // last_polled stamped, but NOT marked complete (would silently swallow a typo).
    expect(cs?.backfillComplete).toBe(false);
  });
});

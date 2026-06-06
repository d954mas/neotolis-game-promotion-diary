// IG account walker — resumable, cursor-persisted (BACK-02, PLAT-01, Pitfall 4).
//
// Drives the REAL handleBackfillAccount against real Postgres; the ScrapeCreators
// boundary is faked at the PROVIDER SEAM (vi.mock of provider/registry's
// getSocialProvider → a controllable fake SocialProvider), NEVER the DB. The
// uniform ProviderPage hides the posts(next_max_id)/reels(paging_info.max_id)
// cursor divergence (Plan 02), so the walker only ever sees nextCursor.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

// Per-feed scripted pages. Keyed "posts"/"reels"; each call shifts the next
// page off the queue. The fake provider reserves NO credits (it bypasses the
// HTTP seam) — budget wiring is covered by social-budget-throttle + http.ts.
interface ScriptedProvider {
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
  calls: Array<{ feed: "posts" | "reels"; cursor: string | null }>;
  /** When set for a feed, the next fetchPosts call for that feed throws an
   *  AdapterError of this category (budget-pause simulation) instead of paging. */
  throwOn: { posts?: "rate-limited" | "operator-issue"; reels?: "rate-limited" | "operator-issue" };
}

const provider: ScriptedProvider = {
  pages: { posts: [], reels: [] },
  calls: [],
  throwOn: {},
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
          const category = provider.throwOn[feed];
          if (category !== undefined) {
            // Simulate the BUDGET-02 reserve refusal the HTTP seam raises when the
            // operator's prepaid budget / daily-cap is exhausted (instagram/http.ts).
            const { AdapterError: Err } = await import("../../src/lib/sources/errors.js");
            throw new Err("scripted budget pause", { category });
          }
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
const { env } = await import("../../src/lib/server/config/env.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { outbox } = await import("../../src/lib/server/db/schema/outbox.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { instagramPosts } = await import("../../src/lib/server/db/schema/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");
const { getInstagramBackfillState } =
  await import("../../src/lib/sources/instagram/server/backfill-state.js");

const ACCOUNT = "acct-walker";

/** Read pending continuation jobs queued for THIS account via the outbox. The
 *  continuation is enqueued via enqueueViaOutbox (atomic with the cursor write),
 *  so the queue intent lives in the outbox table until the forwarder ships it. */
async function readContinuationOutbox() {
  const rows = await db.select().from(outbox).where(eq(outbox.queue, "instagram.backfill.account"));
  return rows.filter((r) => (r.payload as { channelKey?: string }).channelKey === ACCOUNT);
}

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
  const user = await seedUserDirectly({
    email: `walker-${Math.random().toString(36).slice(2)}@t.io`,
  });
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

const envMut = env as { SOCIAL_BACKFILL_MAX_POSTS: number };
let originalMaxPosts: number;

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
  provider.calls = [];
  provider.throwOn = {};
  originalMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
});
afterEach(() => {
  envMut.SOCIAL_BACKFILL_MAX_POSTS = originalMaxPosts;
});

describe("instagram account walker (resumable, cursor-persisted)", () => {
  it("posts endpoint paginates via the uniform cursor and persists it to data_source_channel_state.metadata between ticks", async () => {
    await seedSource();
    // Tick 1: posts page with a cursor (more_available); reels empty (ends).
    provider.pages.posts = [
      {
        posts: [post("p1", 1), post("p2", 2)],
        nextCursor: "CURSOR_A",
        endOfFeed: false,
        creditsUsed: 1,
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
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
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
      {
        posts: [post("r1", 1, "video")],
        nextCursor: "REEL_CURSOR",
        endOfFeed: false,
        creditsUsed: 1,
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
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
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
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
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
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
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const [src] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
    expect(src?.needsReconnect).toBe(true);
    expect(src?.lastErrorKind).toBe("not-found");

    const cs = await readChannelState();
    // last_polled stamped, but NOT marked complete (would silently swallow a typo).
    expect(cs?.backfillComplete).toBe(false);
  });
});

// F2 — the resumable backfill walker now SELF-ENQUEUES a continuation via the
// outbox (atomic with the cursor write) so a multi-page bounded initial/historical
// backfill completes promptly instead of crawling one page per 6h cron tick.
// Termination is load-bearing: continue ONLY on the deep branch while NOT complete,
// NOT paused-by-budget, AND under the post-count cap.
describe("instagram account walker — self-enqueued continuation (F2)", () => {
  it("a 2-page deep backfill enqueues a continuation on tick 1, then completes on tick 2 with NO further continuation", async () => {
    await seedSource();
    // Tick 1: posts page 1 has a cursor (more available); reels empty (ends).
    provider.pages.posts = [
      {
        posts: [post("c1", 1), post("c2", 2)],
        nextCursor: "PAGE2",
        endOfFeed: false,
        creditsUsed: 1,
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

    // Account NOT complete (posts feed still has a cursor) AND deep branch →
    // exactly ONE continuation queued via the outbox (atomic with cursor write).
    let cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    let continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);
    const payload = continuations[0]!.payload as {
      channelKey: string;
      flow: string;
      triggerUserId?: string;
    };
    expect(payload.channelKey).toBe(ACCOUNT);
    expect(payload.flow).toBe("initial");
    // Continuation runs on the cron pool — triggerUserId omitted (trigger pays once).
    expect(payload.triggerUserId).toBeUndefined();
    // singletonKey dedupes parallel triggers for this account.
    expect((continuations[0]!.options as { singletonKey?: string }).singletonKey).toBe(
      `backfill-account-${ACCOUNT}`,
    );

    // Tick 2 (the continuation): posts page 2 ends → both feeds complete →
    // account complete → NO further continuation.
    provider.pages.posts = [
      { posts: [post("c3", 3)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = []; // reels already complete — walker skips it

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);
    // Still exactly ONE continuation row total — tick 2 did NOT enqueue another
    // (account complete is the terminal stop; no infinite loop).
    continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);

    const inserted = await db.select().from(events).where(eq(events.kind, "instagram_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("a budget-paused tick enqueues NO continuation (cron retries after the daily-cap reset)", async () => {
    await seedSource();
    // The posts feed reserve is refused (budget exhausted) → AdapterError
    // rate-limited → the walker pauses this tick and persists the cursor, but
    // MUST NOT self-continue (the next reserve would be refused too — spin).
    provider.throwOn.posts = "rate-limited";
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    // No continuation — a budget pause is NOT a resume trigger.
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(0);
  });

  it("a cap-reached tick enqueues NO continuation (the post-count cap is a terminal bound)", async () => {
    envMut.SOCIAL_BACKFILL_MAX_POSTS = 2;
    await seedSource();
    // The provider would page forever (cursor always set), but the cap=2 stops
    // the deep walk after 2 posts → the posts feed is marked complete at the cap
    // → account complete → NO continuation.
    provider.pages.posts = [
      {
        posts: [post("k1", 1), post("k2", 2)],
        nextCursor: "MORE",
        endOfFeed: false,
        creditsUsed: 1,
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

    const st = await getInstagramBackfillState(ACCOUNT);
    expect(st.collected).toBe(2); // exactly the cap
    expect(st.posts.complete).toBe(true);
    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(0);
  });

  it("an incremental new-only sweep NEVER self-continues even when a feed page returns a cursor (page-1-reset would loop)", async () => {
    // Seed a COMPLETE account so a subsequent tick takes the incremental/exhausted
    // branch (which resets every feed to page 1 each tick — a continuation there
    // would re-fetch page 1 forever).
    await seedSource();
    // Tick 1 (deep): each feed returns ONE post then ends → account complete.
    // (A genuinely-empty first page on a brand-new source trips the Pitfall-4
    // not_found heuristic instead of completing — so we collect a real post.)
    provider.pages.posts = [
      { posts: [post("seed_p", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [
      { posts: [post("seed_r", 1, "video")], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });
    expect((await readChannelState())?.backfillComplete).toBe(true);
    // Clear any continuation noise from the deep tick (there should be none —
    // tick 1 completed the account, so shouldContinue was false).
    await db.delete(outbox);

    // Tick 2 (incremental/exhausted): posts page 1 returns a cursor (more new
    // posts), so the feed is NOT marked complete this tick — but the incremental
    // branch resets to page 1 every tick, so a continuation would loop.
    provider.pages.posts = [
      { posts: [post("n1", 1)], nextCursor: "NEWMORE", endOfFeed: false, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    // No continuation — the incremental branch is single-page-by-design.
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(0);
  });
});

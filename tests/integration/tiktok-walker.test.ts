// TikTok account walker — resumable, cursor-persisted, SINGLE-FEED (mirrors the IG
// walker, collapsed to one feed). Drives the REAL handleBackfillAccount against
// real Postgres; the ScrapeCreators boundary is faked at the PROVIDER SEAM (vi.mock
// of provider/registry's getSocialProvider → a controllable fake SocialProvider),
// NEVER the DB.
//
// Requirements: PLAT-02.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

// Single-feed scripted pages. Each fetchPosts call shifts the next page off the
// queue. The fake provider reserves NO credits (it bypasses the HTTP seam).
interface ScriptedProvider {
  pages: ProviderPage[];
  calls: Array<{ cursor: string | null }>;
  /** When set, the next fetchPosts call throws an AdapterError of this category
   *  (budget-pause simulation) instead of paging. */
  throwOn: "rate-limited" | "operator-issue" | null;
}

const provider: ScriptedProvider = { pages: [], calls: [], throwOn: null };

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
        async fetchPosts(
          _platform: string,
          _handle: string,
          cursor: string | null,
        ): Promise<ProviderPage> {
          provider.calls.push({ cursor });
          if (provider.throwOn !== null) {
            const { AdapterError: Err } = await import("../../src/lib/sources/errors.js");
            throw new Err("scripted budget pause", { category: provider.throwOn });
          }
          return provider.pages.shift() ?? emptyPage();
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
const { tiktokPosts, tiktokAccounts, tiktokPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { getTikTokBackfillState } =
  await import("../../src/lib/sources/tiktok/server/backfill-state.js");

const ACCOUNT = "acct-walker-tk";

async function readContinuationOutbox() {
  const rows = await db.select().from(outbox).where(eq(outbox.queue, "tiktok.backfill.account"));
  return rows.filter((r) => (r.payload as { channelKey?: string }).channelKey === ACCOUNT);
}

function post(id: string, daysAgo: number, shares: number | null = 100) {
  return {
    id,
    kind: "video" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: 1000, likes: 10, comments: 2, shares },
    caption: `caption ${id}`,
    thumbnailUrl: `https://cdn.tiktokcdn-us.com/${id}.awebp`,
    permalink: `https://www.tiktok.com/@walkeracct/video/${id}`,
  };
}

async function seedSource(opts: { autoImport?: boolean } = {}): Promise<string> {
  const user = await seedUserDirectly({
    email: `walker-tk-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@walkeracct",
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
        eq(dataSourceChannelState.kind, "tiktok_account"),
        eq(dataSourceChannelState.channelKey, ACCOUNT),
      ),
    )
    .limit(1);
  return row;
}

const envMut = env as { SOCIAL_BACKFILL_MAX_POSTS: number };
let originalMaxPosts: number;

beforeEach(() => {
  provider.pages = [];
  provider.calls = [];
  provider.throwOn = null;
  originalMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
});
afterEach(() => {
  envMut.SOCIAL_BACKFILL_MAX_POSTS = originalMaxPosts;
});

describe("tiktok account walker (single-feed, resumable, cursor-persisted)", () => {
  it("[10-04] walks one feed page, inserts events + the tiktok_posts cache rows (WITH share_count)", async () => {
    await seedSource();
    provider.pages = [
      {
        posts: [post("w1", 1, 4974), post("w2", 2, 23698)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
        owner: { accountId: ACCOUNT, username: "walkeracct", avatarUrl: "https://cdn/av.awebp" },
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const inserted = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["w1", "w2"]);

    const cached = await db.select().from(tiktokPosts);
    expect(cached.map((p) => p.awemeId).sort()).toEqual(["w1", "w2"]);
    expect(cached.every((p) => p.accountId === ACCOUNT)).toBe(true);

    // The PLAT-02 delta: share_count was stored in the snapshot rows.
    const snaps = await db.select().from(tiktokPostSnapshots);
    const byAweme = new Map(snaps.map((s) => [s.awemeId, s.shareCount]));
    expect(byAweme.get("w1")).toBe(4974);
    expect(byAweme.get("w2")).toBe(23698);

    // The FREE feed owner UPSERTed the subject entity with NO extra call.
    const [acct] = await db
      .select()
      .from(tiktokAccounts)
      .where(eq(tiktokAccounts.accountId, ACCOUNT));
    expect(acct).toBeDefined();
    expect(acct!.username).toBe("walkeracct");
    // Only ONE provider call (the single feed) — no posts/reels two-feed split.
    expect(provider.calls).toHaveLength(1);
  });

  it("[10-04] persists the next cursor and resumes from it on the following tick", async () => {
    await seedSource();
    // Tick 1: a page with a cursor (more available).
    provider.pages = [
      {
        posts: [post("p1", 1), post("p2", 2)],
        nextCursor: "CURSOR_A",
        endOfFeed: false,
        creditsUsed: 1,
        owner: { accountId: ACCOUNT, username: "walkeracct", avatarUrl: null },
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const st1 = await getTikTokBackfillState(ACCOUNT);
    expect(st1.cursor).toBe("CURSOR_A");
    expect(st1.complete).toBe(false);

    // Tick 2 resumes from the persisted cursor.
    provider.pages = [
      { posts: [post("p3", 3)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.calls = [];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    // The second tick passed the stored cursor back to the provider.
    expect(provider.calls[0]?.cursor).toBe("CURSOR_A");
    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);

    const inserted = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("[10-04] an empty first page on a brand-new source flips not_found, NOT backfill_complete (Pitfall 4)", async () => {
    const sourceId = await seedSource();
    provider.pages = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const [src] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
    expect(src?.needsReconnect).toBe(true);
    expect(src?.lastErrorKind).toBe("not-found");

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
  });

  it('[10-04] the backfill audit row carries platform: "tiktok"', async () => {
    const user = await seedUserDirectly({
      email: `walker-tk-audit-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await db.insert(dataSources).values({
      userId: user.id,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@walkeracct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "walkeracct", accountId: ACCOUNT },
    });
    provider.pages = [
      { posts: [post("a1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    ];

    // triggerUserId set → the audit row is written (Pitfall 5: trigger pays once).
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, user.id));
    const backfillRows = rows.filter(
      (r) => (r.metadata as { platform?: string }).platform === "tiktok",
    );
    expect(backfillRows.length).toBeGreaterThanOrEqual(1);
    expect((backfillRows[0]!.metadata as { requests_used?: number }).requests_used).toBe(1);
  });
});

describe("tiktok account walker — self-enqueued continuation", () => {
  it("[10-04] a 2-page deep backfill enqueues a continuation on tick 1, completes on tick 2 with NO further continuation", async () => {
    await seedSource();
    provider.pages = [
      {
        posts: [post("c1", 1), post("c2", 2)],
        nextCursor: "PAGE2",
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
        flow: "initial",
      },
    });

    let cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    let continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);
    const payload = continuations[0]!.payload as { channelKey: string; triggerUserId?: string };
    expect(payload.channelKey).toBe(ACCOUNT);
    expect(payload.triggerUserId).toBeUndefined();
    expect((continuations[0]!.options as { singletonKey?: string }).singletonKey).toBe(
      `backfill-account-${ACCOUNT}`,
    );

    // Tick 2 (the continuation): page 2 ends → account complete → NO further continuation.
    provider.pages = [
      { posts: [post("c3", 3)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);
    continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);

    const inserted = await db.select().from(events).where(eq(events.kind, "tiktok_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("[10-04] a budget-paused tick enqueues NO continuation and persists operatorPaused=true", async () => {
    await seedSource();
    provider.throwOn = "rate-limited";

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    const st = await getTikTokBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(0);
  });
});

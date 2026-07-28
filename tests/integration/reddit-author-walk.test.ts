// Reddit author-walk completeness (Phase 12, Plan 12-05) — HIGH-RISK behavior (A):
// the ScrapeCreators author-search walker pages the feed accumulating ALL posts and
// terminates on the spike-confirmed end-of-feed signal (`after` absent/null, NOT empty
// posts[]). Asserted against the committed 12-01 spike fixture
// tests/fixtures/reddit/author-search-page.json (3 pages, 17 posts, 2020→2026, terminal
// null-`after`). REAL handleBackfillAccount against real Postgres; the provider fetch is
// mocked with the fixture pages (no HTTP).
//
// Requirements: PLAT-04 / behavior (A).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import authorFixture from "../fixtures/reddit/author-search-page.json";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";
import type { DailyUserRequestAccounting } from "../../src/lib/server/daily-user-quota.js";

const provider = {
  pages: [] as RedditFeedPage[],
  errors: [] as Error[],
  onFetch: null as null | (() => Promise<void>),
  calls: 0,
};

function emptyPage(): RedditFeedPage {
  return {
    posts: [],
    nextCursor: null,
    endOfFeed: true,
    creditsUsed: 1,
    owner: null,
    droppedCount: 0,
  };
}

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "reddit" ? ({ name: "scrapecreators-reddit" } as never) : null,
  };
});

vi.mock(
  "../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js",
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      fetchRedditFeedPage: async (
        _mode: string,
        _handle: string,
        _cursor: string | null,
        opts: {
          origin?: "cron" | "user";
          userAccounting?: DailyUserRequestAccounting;
        },
      ): Promise<RedditFeedPage> => {
        if (provider.onFetch !== null) {
          const onFetch = provider.onFetch;
          provider.onFetch = null;
          await onFetch();
        }
        const { reserveSocialCredits } =
          await import("../../src/lib/sources/reddit/server/quota.js");
        const permit =
          opts.origin === "user" && opts.userAccounting !== undefined
            ? await reserveSocialCredits({
                platform: "reddit",
                provider: "scrapecreators",
                origin: "user",
                units: 1,
                userAccounting: opts.userAccounting,
              })
            : await reserveSocialCredits({
                platform: "reddit",
                provider: "scrapecreators",
                origin: opts.origin ?? "cron",
                units: 1,
              });
        if (permit === null) throw new Error("scripted Reddit reservation denied");
        provider.calls += 1;
        const error = provider.errors.shift();
        if (error !== undefined) throw error;
        const page = provider.pages.shift() ?? emptyPage();
        return page;
      },
    };
  },
);

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-account.js");
const { getRedditBackfillState, writeRedditBackfillState } =
  await import("../../src/lib/sources/reddit/server/backfill-state.js");
const { markChannelBackfillFrontier, markChannelLastPolledAt } =
  await import("../../src/lib/server/services/channel-state.js");

const DAY = 86_400_000;
const FIXTURE_PAGES = (authorFixture as { pages: unknown[] }).pages;
const ALL_FIXTURE_POSTS = FIXTURE_PAGES.flatMap((p) => (p as { posts: unknown[] }).posts);

// The fixture is frozen from the u/d954mas spike, but each test isolates on a RANDOM
// handle — stamp the fixture authors to the walked handle so the walker's
// subject-identity belt (an author walk drops posts NOT by the searched author) sees
// what a real author-search returns: pages where every post IS by the subject.
function normalizedFixturePages(handle: string): RedditFeedPage[] {
  return FIXTURE_PAGES.map((p) => {
    const page = normalizeRedditFeed(p);
    for (const post of page.posts) post.author = handle;
    return page;
  });
}

async function seedAccountSource(handle: string, backfillTargetSince?: Date): Promise<string> {
  const user = await seedUserDirectly({
    email: `rdt-walk-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      isOwnedByMe: true,
      autoImport: true,
      backfillTargetSince,
      metadata: { handle },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
  provider.errors = [];
  provider.onFetch = null;
  provider.calls = 0;
});

describe("reddit author-walk completeness (Phase 12, spike-frozen)", () => {
  it("[CR-01] a user walk starting at cap-1 never issues page two", async () => {
    const { env } = await import("../../src/lib/server/config/env.js");
    const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
    const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
    const handle = `capwalk_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    const [source] = await db
      .select({ userId: dataSources.userId })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    for (let i = 0; i < cap - 1; i++) {
      await writeAuditStrict({
        userId: source!.userId,
        action: "source.refresh_content_requested",
        ipAddress: "0.0.0.0",
        metadata: {
          kind: "reddit_account",
          platform: "reddit_account",
          flow: "incremental",
          requests_used: 1,
          events_inserted: 0,
        },
      });
    }
    provider.pages = [{ ...emptyPage(), nextCursor: "page-2", endOfFeed: false }, emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        triggerUserId: source!.userId,
        depthBoundIso: new Date(0).toISOString(),
        flow: "initial",
      },
    });

    expect(provider.calls).toBe(1);
    expect((await getUserQuotaUsedToday(source!.userId, "reddit_account")).requests).toBe(cap);
    const state = await getRedditBackfillState("reddit_account", handle);
    expect(state.cursor).toBe("page-2");
    expect(state.complete).toBe(false);
  });

  it("[CR-01] a reserved not-found page advances the user's request ledger exactly once", async () => {
    const sourceId = await seedAccountSource(`missing_${Math.random().toString(36).slice(2, 7)}`);
    const [source] = await db
      .select({ userId: dataSources.userId, channelId: dataSources.channelId })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
    const before = await getUserQuotaUsedToday(source!.userId, "reddit_account");
    provider.errors = [new AdapterError("missing", { category: "not-found" })];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: source!.channelId!,
        triggerUserId: source!.userId,
        depthBoundIso: new Date(0).toISOString(),
        flow: "initial",
      },
    });

    const after = await getUserQuotaUsedToday(source!.userId, "reddit_account");
    expect(after.requests - before.requests).toBe(1);
  });

  it("[review] requires three consecutive page-1 404s before reconnecting an established source", async () => {
    const handle = `flaky404_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    await markChannelLastPolledAt("reddit_account", handle);

    const runNotFound = async () => {
      provider.errors = [new AdapterError("temporary provider miss", { category: "not-found" })];
      await handleBackfillAccount({
        data: {
          kind: "reddit_account",
          channelKey: handle,
          depthBoundIso: new Date(0).toISOString(),
          flow: "incremental",
        },
      });
      const [source] = await db
        .select({ needsReconnect: dataSources.needsReconnect })
        .from(dataSources)
        .where(eq(dataSources.id, sourceId));
      return source!.needsReconnect;
    };

    expect(await runNotFound(), "one provider 404 is inconclusive").toBe(false);
    expect(await runNotFound(), "two consecutive provider 404s remain inconclusive").toBe(false);
    expect(
      await runNotFound(),
      "the third consecutive provider 404 confirms the subject miss",
    ).toBe(true);
  });

  it("[review] never treats a 404 on a persisted deep cursor as a subject-level miss", async () => {
    const handle = `resume404_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    await markChannelLastPolledAt("reddit_account", handle);
    await writeRedditBackfillState("reddit_account", handle, {
      cursor: "persisted-deep-cursor",
      complete: false,
      collected: 12,
      operatorPaused: false,
      deepTargetIso: new Date(0).toISOString(),
      emptyPasses: 0,
      notFoundPasses: 0,
      servedDeepTargetIso: null,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      provider.errors = [new AdapterError("cursor expired", { category: "not-found" })];
      await handleBackfillAccount({
        data: {
          kind: "reddit_account",
          channelKey: handle,
          depthBoundIso: new Date(0).toISOString(),
          flow: "initial",
        },
      });
    }

    const [source] = await db
      .select({ needsReconnect: dataSources.needsReconnect })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    expect(source!.needsReconnect).toBe(false);

    const state = await getRedditBackfillState("reddit_account", handle);
    expect(state.cursor).toBe("persisted-deep-cursor");
    expect(state.notFoundPasses).toBe(0);
  });

  // REGRESSION: a not-found on ANY page used to abandon the whole pass and flag
  // needs_reconnect on every subscriber. poll-cron filters those out and only a WALK
  // clears the flag — and Reddit has no credentials, so there is no user-facing
  // "Reconnect" affordance either. A one-off provider 404 on page 2 permanently
  // stranded the source AND threw away the cursor + posts page 1 had already paid for.
  it("[CR-06] a not-found on page TWO keeps the pass: posts land, cursor persists, no needs_reconnect", async () => {
    const handle = `midwalk_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    const postId = `mw${Math.random().toString(36).slice(2, 8)}`;

    // Page 1 succeeds and hands out a cursor; page 2 404s.
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: `t3_${postId}`,
            id: postId,
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: "Survives the mid-walk 404",
            selftext: "body",
            score: 3,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - 2 * DAY) / 1000),
            permalink: `/r/gamedev/comments/${postId}/x/`,
          },
        ],
        after: "page-2",
      }),
    ];
    provider.errors = [undefined as never, new AdapterError("gone", { category: "not-found" })];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: new Date(Date.now() - 30 * DAY).toISOString(),
        flow: "initial",
      },
    });

    const [src] = await db
      .select({ needsReconnect: dataSources.needsReconnect })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    expect(src!.needsReconnect, "a mid-walk 404 is a provider hiccup, not a dead subject").toBe(
      false,
    );

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    expect(
      imported.some((e) => e.externalId === `t3_${postId}`),
      "page-1 posts must not be discarded by a page-2 404",
    ).toBe(true);

    const state = await getRedditBackfillState("reddit_account", handle);
    expect(state.cursor, "the paid cursor survives so the next tick resumes").toBe("page-2");
  });

  it("[CR-01] a reserved authoritative empty first page advances the user's ledger exactly once", async () => {
    const sourceId = await seedAccountSource(`empty_${Math.random().toString(36).slice(2, 7)}`);
    const [source] = await db
      .select({ userId: dataSources.userId, channelId: dataSources.channelId })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
    const before = await getUserQuotaUsedToday(source!.userId, "reddit_account");
    provider.pages = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: source!.channelId!,
        triggerUserId: source!.userId,
        depthBoundIso: new Date(0).toISOString(),
        flow: "initial",
      },
    });

    const after = await getUserQuotaUsedToday(source!.userId, "reddit_account");
    expect(after.requests - before.requests).toBe(1);
  });

  it("[12-05] paged author-search accumulates ALL posts across pages + terminates on null-`after`", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    provider.pages = normalizedFixturePages(handle);

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    // ALL 17 fixture posts landed as events, keyed by post.name (t3 fullname).
    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    const mine = imported.filter((e) => (e.externalId ?? "").startsWith("t3_"));
    expect(mine.length).toBe(ALL_FIXTURE_POSTS.length); // 17

    // The walk terminated on the null-`after` terminal page (complete), not mid-feed.
    const st = await getRedditBackfillState("reddit_account", handle);
    expect(st.complete).toBe(true);

    const [cronSpend] = (
      await db.execute(sql`
        SELECT credits_used
        FROM social_provider_spend
        WHERE platform = 'reddit'
          AND provider = 'scrapecreators'
          AND pool_kind = 'cron'
      `)
    ).rows as unknown as Array<{ credits_used: number }>;
    expect(Number(cronSpend!.credits_used)).toBe(FIXTURE_PAGES.length);
  });

  it("[12-05] externalId = post.name (t3_...); every post cached under the t3 fullname", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    provider.pages = normalizedFixturePages(handle);

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const expectedIds = new Set(ALL_FIXTURE_POSTS.map((p) => (p as { name: string }).name));
    const cached = await db.select({ postId: redditPosts.postId }).from(redditPosts);
    const cachedIds = new Set(cached.map((r) => r.postId));
    for (const id of expectedIds) {
      expect(id.startsWith("t3_")).toBe(true);
      expect(cachedIds.has(id)).toBe(true);
    }
  });

  it("[review-P2] a budget-PAUSED deep backfill RESUMES to its original target — a poll-cron 14d tick must not truncate it", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    // Simulate a deep backfill that walked to a 30-day frontier, then PAUSED by budget
    // (complete=false, cursor persisted, collected<max, deepTargetIso = the EPOCH target
    // the deep was pulling to).
    await writeRedditBackfillState("reddit_account", handle, {
      cursor: "resume-cursor",
      complete: false,
      collected: 5,
      operatorPaused: true,
      deepTargetIso: "1970-01-01T00:00:00Z",
      emptyPasses: 0,
      notFoundPasses: 0,
      servedDeepTargetIso: null,
    });
    await markChannelBackfillFrontier("reddit_account", handle, new Date(Date.now() - 30 * DAY));
    await markChannelLastPolledAt("reddit_account", handle);

    // The provider returns one page carrying a 40-DAY-OLD post (older than a 14d window).
    const oldPost = {
      name: "t3_oldie",
      id: "oldie",
      author: handle,
      author_fullname: "t2_oldie",
      subreddit: "gamedev",
      title: "Ancient devlog",
      selftext: "old body",
      score: 3,
      num_comments: 1,
      created_utc: Math.floor((Date.now() - 40 * DAY) / 1000),
      permalink: "/r/gamedev/comments/oldie/x/",
    };
    provider.pages = [normalizeRedditFeed({ success: true, posts: [oldPost], after: null })];

    // A poll-cron auto_passive tick arrives with the 14-DAY incremental window.
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: new Date(Date.now() - 14 * DAY).toISOString(),
        flow: "auto_passive",
      },
    });

    // The 40-day-old post WAS imported: the walk resumed DEEP to the persisted EPOCH
    // target, not the 14d window (which would have crossed-bound + dropped it). A
    // regression that flips to incremental imports nothing here.
    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    expect(
      imported.some((e) => e.externalId === "t3_oldie"),
      "old post imported via deep resume",
    ).toBe(true);
    const st = await getRedditBackfillState("reddit_account", handle);
    expect(st.complete).toBe(true); // the resumed deep reached end-of-feed
  });

  it("[12-05] the backfill audit tags metadata.platform = reddit_account (QUOTA_PLATFORM, NOT reddit)", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    const ownerRows = await db
      .select({ userId: dataSources.userId })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    const userId = ownerRows[0]!.userId;
    provider.pages = normalizedFixturePages(handle);

    // triggerUserId set → the trigger user pays the per-user cap (audit written).
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        triggerUserId: userId,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const backfill = rows.find((r) => r.action === "source.refresh_content_requested");
    expect(backfill, "a backfill audit row must exist for the trigger user").toBeDefined();
    expect((backfill!.metadata as { platform?: string }).platform).toBe("reddit_account");
  });

  it("[review-P1] off-subject posts are DROPPED (broad-search fuzz) and the drop suppresses the disappearance reconcile", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    const mine = `m${Math.random().toString(36).slice(2, 8)}`;
    const foreign = `x${Math.random().toString(36).slice(2, 8)}`;
    const tracked = `t${Math.random().toString(36).slice(2, 8)}`;

    // An ESTABLISHED channel with one previously-tracked subject post that the page
    // below does NOT re-sight — a lossless pass would flag it deleted; the lossy
    // (off-subject-drop) pass must NOT.
    await db.insert(redditPosts).values({
      postId: `t3_${tracked}`,
      author: handle,
      subredditSlug: "gamedev",
      title: "previously tracked",
      publishedAt: new Date(Date.now() - 1 * DAY),
      lastPolledAt: new Date(),
      lastPollStatus: "ok",
    });
    await markChannelLastPolledAt("reddit_account", handle);

    const post = (id: string, author: string) => ({
      name: `t3_${id}`,
      id,
      author,
      author_fullname: `t2_${author}`,
      subreddit: "gamedev",
      title: `Devlog ${id}`,
      selftext: "body",
      score: 1,
      num_comments: 0,
      created_utc: Math.floor((Date.now() - 1 * DAY) / 1000),
      permalink: `/r/gamedev/comments/${id}/x/`,
    });
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [post(mine, handle), post(foreign, "someone_else")],
        after: null,
      }),
    ];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: new Date(Date.now() - 14 * DAY).toISOString(),
        flow: "auto_passive",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    expect(
      imported.some((e) => e.externalId === `t3_${mine}`),
      "subject post imported",
    ).toBe(true);
    expect(
      imported.some((e) => e.externalId === `t3_${foreign}`),
      "off-subject post must NOT be imported",
    ).toBe(false);
    const [foreignCached] = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${foreign}`));
    expect(foreignCached, "off-subject post must NOT be cached").toBeUndefined();
    const [trackedRow] = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${tracked}`));
    expect(
      trackedRow!.deletionDetectedAt,
      "lossy (dropped) pass must not flag disappearances",
    ).toBeNull();
  });

  it("[review-P1] a NEW subscriber's DEEPER initial walk re-opens a COMPLETE channel (exhausted must not discard the target)", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    // Channel already walked COMPLETE to a 7-day frontier.
    await writeRedditBackfillState("reddit_account", handle, {
      cursor: null,
      complete: true,
      collected: 4,
      operatorPaused: false,
      deepTargetIso: null,
      emptyPasses: 0,
      notFoundPasses: 0,
      servedDeepTargetIso: null,
    });
    await markChannelBackfillFrontier("reddit_account", handle, new Date(Date.now() - 7 * DAY));
    const { markChannelBackfillComplete } =
      await import("../../src/lib/server/services/channel-state.js");
    await markChannelBackfillComplete("reddit_account", handle);
    await markChannelLastPolledAt("reddit_account", handle);

    // THREE pages of history — the deep page cap (30) reaches page 3; the incremental
    // cap (2) that the buggy `exhausted` branch used would stop before the 40-day post.
    const mk = (id: string, daysAgo: number, cursor: string | null) =>
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: `t3_${id}`,
            id,
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: `Devlog ${id}`,
            selftext: "body",
            score: 1,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
            permalink: `/r/gamedev/comments/${id}/x/`,
          },
        ],
        after: cursor,
      });
    const deepId = `d${Math.random().toString(36).slice(2, 8)}`;
    provider.pages = [
      mk(`a${Math.random().toString(36).slice(2, 8)}`, 2, "c2"),
      mk(`b${Math.random().toString(36).slice(2, 8)}`, 20, "c3"),
      mk(deepId, 40, null),
    ];

    // A new tenant's INITIAL walk requests 60 days of history — deeper than the frontier.
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: new Date(Date.now() - 60 * DAY).toISOString(),
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    expect(
      imported.some((e) => e.externalId === `t3_${deepId}`),
      "page-3 (40-day) post imported — the deep walk re-opened past the stale frontier",
    ).toBe(true);
  });

  it("[CR-04] a subscriber added during an active walk widens the target without losing history", async () => {
    const handle = `race_${Math.random().toString(36).slice(2, 7)}`;
    const shallowTarget = new Date(Date.now() - 7 * DAY);
    const deepTarget = new Date(Date.now() - 60 * DAY);
    await seedAccountSource(handle, shallowTarget);

    const mk = (id: string, daysAgo: number) =>
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: `t3_${id}`,
            id,
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: `Devlog ${id}`,
            selftext: "body",
            score: 1,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
            permalink: `/r/gamedev/comments/${id}/x/`,
          },
        ],
        after: null,
      });
    const shallowStop = `s${Math.random().toString(36).slice(2, 8)}`;
    const deepId = `d${Math.random().toString(36).slice(2, 8)}`;
    provider.pages = [mk(shallowStop, 10), mk(deepId, 40)];
    provider.onFetch = async () => {
      await seedAccountSource(handle, deepTarget);
    };

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: shallowTarget.toISOString(),
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    expect(
      imported.some((event) => event.externalId === `t3_${deepId}`),
      "active walk follows the deepest subscriber target",
    ).toBe(true);
  });

  // REGRESSION: the widened-target recursion compared a subscriber's
  // backfill_target_since against THIS pass's depth bound instead of the coverage
  // frontier the channel had already reached. poll-cron always bounds at now-14d
  // while a default source carries now-30d, so `now-30d < now-14d` held on EVERY
  // completed pass — re-firing a forceDeep re-walk of already-covered ground daily,
  // forever, billed to the subscriber's PERSONAL daily quota and importing nothing.
  it("[CR-05] a cron pass over an already-deeper-walked channel does NOT re-fire the widened deep walk", async () => {
    const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
    const handle = `covered_${Math.random().toString(36).slice(2, 7)}`;
    // Subscriber wants 30d back; the channel has ALREADY been walked to 400d.
    const sourceId = await seedAccountSource(handle, new Date(Date.now() - 30 * DAY));
    const [subscriber] = await db
      .select({ userId: dataSources.userId })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    await markChannelBackfillFrontier("reddit_account", handle, new Date(Date.now() - 400 * DAY));
    await markChannelLastPolledAt("reddit_account", handle);

    // One page whose oldest post crosses the cron bound → the pass completes.
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: "t3_fresh01",
            id: "fresh01",
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: "Recent devlog",
            selftext: "body",
            score: 5,
            num_comments: 1,
            created_utc: Math.floor((Date.now() - 20 * DAY) / 1000),
            permalink: "/r/gamedev/comments/fresh01/x/",
          },
        ],
        after: "page-2",
      }),
    ];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: new Date(Date.now() - 14 * DAY).toISOString(),
        flow: "auto_passive",
      },
    });

    // Exactly one fetch: page 1 crosses the 14d bound and completes the pass. A
    // re-fired widened recursion resets the cursor and fetches again (2+).
    expect(provider.calls, "cron pass must not re-walk already-covered depth").toBe(1);
    // ...and it must not have been billed to the subscriber. The recursion passes
    // triggerUserId, which flips the fetch to origin:"user" + userAccounting — that is
    // how a daily cron re-walk silently ate the user's own LIMIT_SOCIAL_REQUESTS_PER_DAY.
    expect(
      (await getUserQuotaUsedToday(subscriber!.userId, "reddit_account")).requests,
      "a cron pass must not consume the subscriber's personal daily quota",
    ).toBe(0);
  });

  it("[review-P1] a COMPLETED deep pass records its target as served — the settle memory for unreachable targets", async () => {
    const handle = `served_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    const target = new Date(Date.now() - 30 * DAY);
    // The whole feed is ONE post at 12d — the walk exhausts ABOVE the 30d target, so
    // the frontier (12d) stays shallower than the target forever. Without the served
    // memory every later pull relabels initial and re-pays this exact walk.
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: "t3_young01",
            id: "young01",
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: "Only post",
            selftext: "body",
            score: 1,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - 12 * DAY) / 1000),
            permalink: "/r/gamedev/comments/young01/x/",
          },
        ],
        after: null,
      }),
    ];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: target.toISOString(),
        flow: "initial",
      },
    });

    const state = await getRedditBackfillState("reddit_account", handle);
    expect(state.complete).toBe(true);
    expect(
      state.servedDeepTargetIso,
      "the completed deep pass records the target it walked FOR",
    ).toBe(target.toISOString());
  });

  it("[review-P2] an EMPTY successful rehab pass keeps needs_reconnect; a sighting clears it", async () => {
    const handle = `rehab_${Math.random().toString(36).slice(2, 7)}`;
    const sourceId = await seedAccountSource(handle);
    await markChannelLastPolledAt("reddit_account", handle);
    // Flagged earlier (empty first page on a new source / three 404s) — the weekly
    // rehab lane re-enqueues one walk to probe recovery.
    await db.update(dataSources).set({ needsReconnect: true }).where(eq(dataSources.id, sourceId));

    const readFlag = async () => {
      const [src] = await db
        .select({ needsReconnect: dataSources.needsReconnect })
        .from(dataSources)
        .where(eq(dataSources.id, sourceId));
      return src!.needsReconnect;
    };
    const walk = () =>
      handleBackfillAccount({
        data: {
          kind: "reddit_account",
          channelKey: handle,
          depthBoundIso: new Date(Date.now() - 14 * DAY).toISOString(),
          flow: "auto_passive",
        },
      });

    // The author search answers a typo'd/private/empty subject with an empty 200 —
    // an empty pass proves nothing and must NOT return the source to daily paid
    // polling (nothing could ever re-flag it: the search path never 404s).
    provider.pages = [emptyPage()];
    await walk();
    expect(await readFlag(), "an empty rehab pass is not recovery evidence").toBe(true);

    // A page WITH posts is direct evidence the subject exists — the flag clears.
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: "t3_rehab01",
            id: "rehab01",
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: "Back alive",
            selftext: "body",
            score: 1,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - 2 * DAY) / 1000),
            permalink: "/r/gamedev/comments/rehab01/x/",
          },
        ],
        after: null,
      }),
    ];
    await walk();
    expect(await readFlag(), "a sighted post clears the flag").toBe(false);
  });

  it("[review-P2] a parse-lossy pass leaves an ARCHIVE intent pending; a lossless pass coalesces it", async () => {
    const { outbox } = await import("../../src/lib/server/db/schema/outbox.js");
    const { QUEUES } = await import("../../src/lib/server/queues.js");
    const { redditWalkSingletonKey } =
      await import("../../src/lib/sources/reddit/server/backfill-state.js");

    const mkPage = (id: string, handle: string, dropped: number) => ({
      ...normalizeRedditFeed({
        success: true,
        posts: [
          {
            name: `t3_${id}`,
            id,
            author: handle,
            author_fullname: `t2_${handle}`,
            subreddit: "gamedev",
            title: `Devlog ${id}`,
            selftext: "body",
            score: 1,
            num_comments: 0,
            created_utc: Math.floor((Date.now() - 2 * DAY) / 1000),
            permalink: `/r/gamedev/comments/${id}/x/`,
          },
        ],
        after: null,
      }),
      // Simulate mapPostsResilient minority-drops: malformed provider rows silently
      // excluded from posts[] — one of them may BE the archive the intent wants.
      droppedCount: dropped,
    });
    const seedIntent = async (handle: string) => {
      const [row] = await db
        .insert(outbox)
        .values({
          queue: QUEUES.REDDIT_BACKFILL_ACCOUNT,
          payload: {
            kind: "reddit_account",
            channelKey: handle,
            flow: "initial",
            depthBoundIso: new Date(Date.now() - 7 * DAY).toISOString(),
          },
          options: {
            singletonKey: redditWalkSingletonKey("reddit_account", handle),
            retrySingletonConflict: true,
          },
        })
        .returning({ id: outbox.id });
      return row!.id;
    };
    const readForwarded = async (id: string) => {
      const [row] = await db
        .select({ forwardedAt: outbox.forwardedAt })
        .from(outbox)
        .where(eq(outbox.id, id));
      return row!.forwardedAt;
    };
    const walk = (handle: string) =>
      handleBackfillAccount({
        data: {
          kind: "reddit_account",
          channelKey: handle,
          depthBoundIso: new Date(Date.now() - 14 * DAY).toISOString(),
          flow: "initial",
        },
      });

    // LOSSY: the pass completed, but a dropped row may be exactly what the archive
    // intent asked for — it must stay pending for a real (lossless) walk.
    const lossyHandle = `lossy_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(lossyHandle);
    const lossyIntent = await seedIntent(lossyHandle);
    provider.pages = [mkPage(`l${Math.random().toString(36).slice(2, 7)}`, lossyHandle, 1)];
    await walk(lossyHandle);
    expect(
      await readForwarded(lossyIntent),
      "a parse-lossy pass must not settle an archive intent",
    ).toBeNull();

    // LOSSLESS: the same-shaped pass with zero drops settles the intent for free.
    const cleanHandle = `clean_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(cleanHandle);
    const cleanIntent = await seedIntent(cleanHandle);
    provider.pages = [mkPage(`c${Math.random().toString(36).slice(2, 7)}`, cleanHandle, 0)];
    await walk(cleanHandle);
    expect(
      await readForwarded(cleanIntent),
      "a lossless complete pass coalesces the covered intent",
    ).not.toBeNull();
  });

  it("[CR-01] real pg-boss defers a same-channel outbox intent and delivers it once after release", async () => {
    const { PgBoss } = await import("pg-boss");
    const { env } = await import("../../src/lib/server/config/env.js");
    const { REDDIT_WALK_QUEUE_OPTIONS } = await import("../../src/lib/server/queues.js");
    const { createSource } = await import("../../src/lib/server/services/data-sources.js");
    const { drainOutboxOnce } = await import("../../src/worker/handlers/outbox-forwarder.js");
    const queue = `reddit.test.exclusive.${Math.random().toString(36).slice(2, 10)}`;
    const handle = `outbox_race_${Math.random().toString(36).slice(2, 7)}`;
    const shallow = new Date(Date.now() - 7 * DAY);
    const deep = new Date(Date.now() - 60 * DAY);
    const first = await seedUserDirectly({ email: `rdt-outbox-a-${handle}@t.io` });
    const second = await seedUserDirectly({ email: `rdt-outbox-b-${handle}@t.io` });
    const boss = new PgBoss({ connectionString: env.DATABASE_URL });
    boss.on("error", () => undefined);

    await boss.start();
    try {
      await boss.createQueue(queue, REDDIT_WALK_QUEUE_OPTIONS);
      expect((await boss.getQueue(queue))!.policy).toBe("exclusive");

      await createSource(
        first.id,
        {
          kind: "reddit_account",
          handleUrl: `https://www.reddit.com/user/${handle}`,
          autoImport: true,
          backfillTargetSince: shallow,
        },
        "127.0.0.1",
      );
      await db.execute(sql`
        UPDATE outbox SET queue = ${queue}
        WHERE payload->>'channelKey' = ${handle} AND forwarded_at IS NULL
      `);
      await drainOutboxOnce(boss);

      const [shallowOutbox] = (
        await db.execute(sql`
          SELECT id, forwarded_at
          FROM outbox
          WHERE payload->>'channelKey' = ${handle}
        `)
      ).rows as unknown as Array<{ id: string; forwarded_at: Date | null }>;
      expect(
        shallowOutbox!.forwarded_at,
        "successful send clears the pending intent",
      ).not.toBeNull();
      const [shallowJob] = await boss.fetch(queue);
      expect(shallowJob!.id, "outbox id is the crash-idempotent pg-boss id").toBe(
        shallowOutbox!.id,
      );

      // Simulate a crash after boss.send succeeded but before forwarded_at was stored.
      await db.execute(sql`
        UPDATE outbox
        SET forwarded_at = NULL, last_attempt_at = NOW() - interval '61 seconds'
        WHERE id = ${shallowOutbox!.id}
      `);
      await drainOutboxOnce(boss);
      const afterCrashRetry = await boss.findJobs(queue, { id: shallowOutbox!.id });
      expect(afterCrashRetry, "crash retry must not create a duplicate active job").toHaveLength(1);

      await createSource(
        second.id,
        {
          kind: "reddit_account",
          handleUrl: `https://www.reddit.com/user/${handle}`,
          autoImport: true,
          backfillTargetSince: deep,
        },
        "127.0.0.1",
      );
      await db.execute(sql`
        UPDATE outbox SET queue = ${queue}
        WHERE payload->>'channelKey' = ${handle} AND forwarded_at IS NULL
      `);
      await drainOutboxOnce(boss);

      const [deepPending] = (
        await db.execute(sql`
          SELECT id, payload, forwarded_at, forwarder_attempt
          FROM outbox
          WHERE payload->>'channelKey' = ${handle}
            AND payload->>'depthBoundIso' = ${deep.toISOString()}
        `)
      ).rows as unknown as Array<{
        id: string;
        payload: { depthBoundIso: string };
        forwarded_at: Date | null;
        forwarder_attempt: number;
      }>;
      expect(deepPending!.forwarded_at, "exclusive-key conflict stays durable").toBeNull();
      expect(deepPending!.forwarder_attempt).toBe(0);
      expect(await boss.fetch(queue), "no duplicate same-key job becomes active").toHaveLength(0);

      await boss.complete(queue, shallowJob!.id);
      await db.execute(sql`
        UPDATE outbox
        SET last_attempt_at = NOW() - interval '61 seconds'
        WHERE id = ${deepPending!.id}
      `);
      await drainOutboxOnce(boss);

      const [deepJob] = await boss.fetch<{ depthBoundIso: string }>(queue);
      expect(deepJob!.id).toBe(deepPending!.id);
      expect(deepJob!.data.depthBoundIso).toBe(deep.toISOString());
      expect(await boss.fetch(queue), "the deeper intent is delivered exactly once").toHaveLength(
        0,
      );
      await boss.complete(queue, deepJob!.id);
    } finally {
      await boss.deleteQueue(queue).catch(() => undefined);
      await boss.stop({ graceful: false });
    }
  });

  it("[certification] concurrent manual pulls remain durable for non-auto-import tenants", async () => {
    const { getBoss } = await import("../../src/lib/server/queue-client.js");
    const { QUEUES, REDDIT_WALK_QUEUE_OPTIONS } = await import("../../src/lib/server/queues.js");
    const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
    const { drainOutboxOnce } = await import("../../src/worker/handlers/outbox-forwarder.js");
    const handle = `manual_race_${Math.random().toString(36).slice(2, 7)}`;
    const first = await seedUserDirectly({ email: `rdt-manual-a-${handle}@t.io` });
    const second = await seedUserDirectly({ email: `rdt-manual-b-${handle}@t.io` });
    const boss = await getBoss();
    await boss.deleteQueue(QUEUES.REDDIT_BACKFILL_ACCOUNT).catch(() => undefined);
    await boss.createQueue(QUEUES.REDDIT_BACKFILL_ACCOUNT, REDDIT_WALK_QUEUE_OPTIONS);

    const [firstSource, secondSource] = await db
      .insert(dataSources)
      .values([
        {
          userId: first.id,
          kind: "reddit_account" as const,
          handleUrl: `https://www.reddit.com/user/${handle}`,
          channelId: handle,
          autoImport: false,
          metadata: { handle },
        },
        {
          userId: second.id,
          kind: "reddit_account" as const,
          handleUrl: `https://www.reddit.com/user/${handle}`,
          channelId: handle,
          autoImport: false,
          metadata: { handle },
        },
      ])
      .returning({
        id: dataSources.id,
        userId: dataSources.userId,
        metadata: dataSources.metadata,
      });

    const firstIntent = await redditAdapter.backfillSource(
      {
        id: firstSource!.id,
        userId: firstSource!.userId,
        metadata: firstSource!.metadata as Record<string, unknown>,
      },
      { userId: first.id, origin: "user" },
    );
    const secondIntent = await redditAdapter.backfillSource(
      {
        id: secondSource!.id,
        userId: secondSource!.userId,
        metadata: secondSource!.metadata as Record<string, unknown>,
      },
      { userId: second.id, origin: "user" },
    );

    expect(firstIntent.jobId).not.toBeNull();
    expect(secondIntent.jobId, "exclusive conflict must be durably recorded").not.toBeNull();
    expect(secondIntent.jobId).not.toBe(firstIntent.jobId);

    await drainOutboxOnce(boss);
    const [firstJob] = await boss.fetch<{ triggerUserId: string }>(QUEUES.REDDIT_BACKFILL_ACCOUNT);
    const pendingIntent =
      firstJob!.data.triggerUserId === first.id
        ? { id: secondIntent.jobId!, userId: second.id }
        : { id: firstIntent.jobId!, userId: first.id };

    const [pendingSecond] = (
      await db.execute(sql`
        SELECT id, forwarded_at, forwarder_attempt
        FROM outbox
        WHERE id = ${pendingIntent.id}
      `)
    ).rows as unknown as Array<{
      id: string;
      forwarded_at: Date | null;
      forwarder_attempt: number;
    }>;
    expect(pendingSecond!.forwarded_at).toBeNull();
    expect(pendingSecond!.forwarder_attempt).toBe(0);

    await boss.complete(QUEUES.REDDIT_BACKFILL_ACCOUNT, firstJob!.id);
    await db.execute(sql`
      UPDATE outbox
      SET last_attempt_at = NOW() - interval '61 seconds'
      WHERE id = ${pendingIntent.id}
    `);
    await drainOutboxOnce(boss);

    const [secondJob] = await boss.fetch<{ triggerUserId: string }>(QUEUES.REDDIT_BACKFILL_ACCOUNT);
    expect(secondJob!.id).toBe(pendingIntent.id);
    expect(secondJob!.data.triggerUserId).toBe(pendingIntent.userId);
    expect(
      await boss.fetch(QUEUES.REDDIT_BACKFILL_ACCOUNT),
      "manual intent is delivered exactly once",
    ).toHaveLength(0);
    await boss.complete(QUEUES.REDDIT_BACKFILL_ACCOUNT, secondJob!.id);
  });
});

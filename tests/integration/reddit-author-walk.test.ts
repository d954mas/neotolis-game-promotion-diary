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
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import authorFixture from "../fixtures/reddit/author-search-page.json";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";

const provider = { pages: [] as RedditFeedPage[] };

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
      fetchRedditFeedPage: async (): Promise<RedditFeedPage> =>
        provider.pages.shift() ?? emptyPage(),
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

function normalizedFixturePages(): RedditFeedPage[] {
  return FIXTURE_PAGES.map((p) => normalizeRedditFeed(p));
}

async function seedAccountSource(handle: string): Promise<string> {
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
      metadata: { handle },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
});

describe("reddit author-walk completeness (Phase 12, spike-frozen)", () => {
  it("[12-05] paged author-search accumulates ALL posts across pages + terminates on null-`after`", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    provider.pages = normalizedFixturePages();

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
  });

  it("[12-05] externalId = post.name (t3_...); every post cached under the t3 fullname", async () => {
    const handle = `d954mas_${Math.random().toString(36).slice(2, 7)}`;
    await seedAccountSource(handle);
    provider.pages = normalizedFixturePages();

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
    provider.pages = normalizedFixturePages();

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
});

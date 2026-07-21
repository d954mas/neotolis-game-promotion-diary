// Reddit NATIVE-subreddit walker (Phase 12) — the reddit_subreddit kind. Every other
// walk test drives handleBackfillAccount (reddit_account); this file is the only cover
// for handleBackfillSubreddit + the subreddit-specific WalkConfig (mode="subreddit" and
// the reconcile subject = reddit_posts.subreddit_slug, vs LOWER(author) for accounts).
// A bug in the subreddit branch (e.g. the wrong reconcile column) would otherwise ship
// green. Asserted against the committed subreddit fixture + synthetic reconcile posts.
// REAL handleBackfillSubreddit against real Postgres; the provider fetch is mocked.
//
// Requirements: PLAT-04.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import subredditFixture from "../fixtures/reddit/subreddit-page.json";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";

const provider = { pages: [] as RedditFeedPage[] };
function emptyPage(): RedditFeedPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null };
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
vi.mock("../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchRedditFeedPage: async (): Promise<RedditFeedPage> => provider.pages.shift() ?? emptyPage(),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillSubreddit } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-subreddit.js");
const { getRedditBackfillState } =
  await import("../../src/lib/sources/reddit/server/backfill-state.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);
const FIXTURE_POSTS = (subredditFixture as { posts: unknown[] }).posts;

function makePost(shortId: string, daysAgo: number, subreddit: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author: `author_${shortId}`,
    author_fullname: `t2_${shortId}`,
    subreddit,
    title: `Devlog ${shortId}`,
    selftext: "body",
    score: 5,
    num_comments: 2,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/${subreddit}/comments/${shortId}/devlog/`,
  };
}
function walkPage(posts: unknown[]): RedditFeedPage {
  return normalizeRedditFeed({ success: true, posts, after: null });
}

async function seedSubredditSource(slug: string): Promise<string> {
  const u = await seedUserDirectly({ email: `rdt-sub-${uniq()}@t.io` });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: u.id,
      kind: "reddit_subreddit",
      handleUrl: `https://www.reddit.com/r/${slug}`,
      channelId: slug,
      isOwnedByMe: false,
      autoImport: true,
      metadata: { slug },
    })
    .returning({ id: dataSources.id, userId: dataSources.userId });
  return row!.userId;
}

async function seedTrackedPost(shortId: string, daysAgo: number, slug: string): Promise<void> {
  await db.insert(redditPosts).values({
    postId: `t3_${shortId}`,
    subredditSlug: slug,
    author: `author_${shortId}`,
    authorFullname: `t2_${shortId}`,
    title: `Devlog ${shortId}`,
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    lastPolledAt: new Date(Date.now() - daysAgo * DAY),
    lastPollStatus: "ok",
  });
}

async function readPost(shortId: string) {
  const [row] = await db
    .select()
    .from(redditPosts)
    .where(eq(redditPosts.postId, `t3_${shortId}`))
    .limit(1);
  return row;
}

beforeEach(() => {
  provider.pages = [];
});

describe("reddit native-subreddit walker (Phase 12)", () => {
  it("[12-05] a subreddit walk imports ALL fixture posts as events + terminates complete", async () => {
    const slug = "gamedev";
    await seedSubredditSource(slug);
    provider.pages = [walkPage(FIXTURE_POSTS)];

    await handleBackfillSubreddit({
      data: { kind: "reddit_subreddit", channelKey: slug, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    const mine = imported.filter((e) => (e.externalId ?? "").startsWith("t3_"));
    expect(mine.length).toBe(FIXTURE_POSTS.length); // all 4 fixture posts

    const st = await getRedditBackfillState("reddit_subreddit", slug);
    expect(st.complete).toBe(true);
  });

  it("[12-05] reconcile keys on subreddit_slug: an absent SAME-subreddit post is flagged; a DIFFERENT-subreddit post is NOT", async () => {
    const slug = `sub_${uniq()}`;
    const other = `oth_${uniq()}`;
    await seedSubredditSource(slug);
    // Present in the walk (slug), so they define the walked window [3d, now].
    const P1 = `p1${uniq()}`, P2 = `p2${uniq()}`;
    // Tracked, in-window, ABSENT from the walk: B in the walked slug, D in a DIFFERENT slug.
    const B = `b${uniq()}`, D = `d${uniq()}`;
    await seedTrackedPost(P1, 1, slug);
    await seedTrackedPost(P2, 3, slug);
    await seedTrackedPost(B, 2, slug);
    await seedTrackedPost(D, 2, other); // different subreddit — the subject filter must exclude it

    // The walk returns only P1 + P2 (oldestSeen = P2@3d → window [3d, now] covers B@2d + D@2d).
    provider.pages = [walkPage([makePost(P1, 1, slug), makePost(P2, 3, slug)])];

    await handleBackfillSubreddit({
      data: { kind: "reddit_subreddit", channelKey: slug, depthBoundIso: "1970-01-01T00:00:00Z", flow: "auto_passive" },
    });

    expect((await readPost(B))!.deletionDetectedAt, "same-subreddit absent post → flagged").not.toBeNull();
    expect((await readPost(D))!.deletionDetectedAt, "different-subreddit post → NOT flagged (subject filter)").toBeNull();
    expect((await readPost(P1))!.deletionDetectedAt, "present post → not flagged").toBeNull();
    expect((await readPost(P2))!.deletionDetectedAt, "present post → not flagged").toBeNull();
  });

  it("[12-05] the subreddit backfill audit tags metadata.platform = reddit_subreddit (QUOTA_PLATFORM)", async () => {
    const slug = `sub_${uniq()}`;
    const userId = await seedSubredditSource(slug);
    provider.pages = [walkPage([makePost(`x${uniq()}`, 1, slug)])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        triggerUserId: userId,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const backfill = rows.find((r) => r.action === "source.refresh_content_requested");
    expect(backfill, "a backfill audit row must exist for the trigger user").toBeDefined();
    expect((backfill!.metadata as { platform?: string }).platform).toBe("reddit_subreddit");
  });
});

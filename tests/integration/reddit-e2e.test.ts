// Reddit end-to-end backfill (mock provider — Phase 12, Plan 12-05). Real Postgres;
// the provider fetch is mocked with a synthetic feed page. Proves the full catch-up
// pipeline: mock provider → backfill handler → reddit_posts + reddit_post_snapshots +
// events INSERT → audit(metadata.platform=reddit_account=QUOTA_PLATFORM) → the per-user
// cap increments on a user-initiated backfill.
//
// Requirements: PLAT-04.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { inArray } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
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
const { redditPosts, redditPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-account.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

function makePost(shortId: string, daysAgo: number, author: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit: "gamedev",
    title: `Devlog ${shortId}`,
    selftext: "body",
    score: 11,
    num_comments: 4,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/gamedev/comments/${shortId}/devlog/`,
  };
}

async function seedAccountSource(handle: string): Promise<{ userId: string; sourceId: string }> {
  const u = await seedUserDirectly({ email: `rdt-e2e-${uniq()}@t.io` });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: u.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle },
    })
    .returning({ id: dataSources.id });
  return { userId: u.id, sourceId: row!.id };
}

beforeEach(() => {
  provider.pages = [];
});

describe("reddit e2e backfill (mock provider — Phase 12)", () => {
  it("[12-05] mock provider → backfill → reddit_posts + snapshots + events + audit(reddit_account) + per-user cap", async () => {
    const handle = `e2e_${uniq()}`;
    const p1 = `x${uniq()}`,
      p2 = `y${uniq()}`;
    const { userId } = await seedAccountSource(handle);
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [makePost(p1, 1, handle), makePost(p2, 2, handle)],
        after: null,
      }),
    ];

    const before = await getUserQuotaUsedToday(userId, "reddit_account");

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        triggerUserId: userId,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const ids = [`t3_${p1}`, `t3_${p2}`];
    // reddit_posts cache rows.
    const posts = await db.select().from(redditPosts).where(inArray(redditPosts.postId, ids));
    expect(posts.length).toBe(2);
    // reddit_post_snapshots rows (like=score, comment=num_comments).
    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(inArray(redditPostSnapshots.postId, ids));
    expect(snaps.length).toBe(2);
    expect(snaps.every((s) => s.likeCount === 11 && s.commentCount === 4)).toBe(true);
    // events INSERTed for the subscriber.
    const evs = await db.select().from(events).where(inArray(events.externalId, ids));
    expect(evs.length).toBe(2);
    expect(evs.every((e) => e.kind === "reddit_post")).toBe(true);

    // The per-user cap incremented (audit metadata.platform=reddit_account SUMs).
    const after = await getUserQuotaUsedToday(userId, "reddit_account");
    expect(after.requests).toBeGreaterThan(before.requests);
  });
});

// Reddit feed visualization (VIZ-05 + PLAT-04) — the full Reddit feed/viz surface
// proven end-to-end (flipped live by Plan 12-06) against the EXISTING cross-source
// feed + chart machinery.
//
// Path: a backfill tick (mock provider) imports reddit_post events into the /feed
// INBOX + writes reddit_post_snapshots (like=score, comment=num_comments) → the /feed
// enrichment (redditEnrichFeedDtos) surfaces likes/comments + the raw i.redd.it
// thumbnail on an image post (null on a self/text post — metrics/thumbnail by
// presence) → attach the event to a game → the /games/[id] metric-series loader
// (getEventMetricSeries iterating allAdapters → redditFetchEventMetricSeries) returns
// the TWO D-09 series (like_count + comment_count) → the chart event-marker
// (eventThumbnail) resolves the i.redd.it cover via the redditEnrichment seam.
//
// D-09 (the Reddit delta vs Twitter): NO views series, NO shares series — Reddit
// exposes neither (12-SPIKE Q4). An image post derives a thumbnail from its i.redd.it
// url; a self/text post has none (image/gallery variant un-sampled by the spike →
// browser-renderability owed at the Task 3 UAT).
//
// Integration test — real Postgres via ./helpers.js; the walker's provider fetch is
// mocked at the reddit tree's provider/registry + scrapecreators-reddit seam (NEVER
// the DB), mirroring reddit-e2e.test.ts.
//
// Requirements: VIZ-05 / PLAT-04.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull, inArray } from "drizzle-orm";
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
const { eventGames } = await import("../../src/lib/server/db/schema/event-games.js");
const { redditPostSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { createGame } = await import("../../src/lib/server/services/games.js");
const { attachEventToGames } = await import("../../src/lib/server/services/events-mutation.js");
const { getEventMetricSeries } = await import(
  "../../src/lib/server/services/event-metric-series.js"
);
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillAccount } = await import(
  "../../src/lib/sources/reddit/server/handlers/backfill-account.js"
);
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");
const { redditEnrichFeedDtos } = await import(
  "../../src/lib/sources/reddit/server/feed-enrichment.js"
);
const { eventThumbnail } = await import("../../src/lib/components/charts/wishlist-chart-shared.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

// A self/text post: selftext non-empty, url is the comments permalink → mediaType
// "self" → no thumbnail. score→likes, num_comments→comments.
function selfPost(shortId: string, daysAgo: number, author: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit: "gamedev",
    title: `Devlog ${shortId}`,
    selftext: "the body text",
    score: 11,
    num_comments: 4,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/gamedev/comments/${shortId}/devlog/`,
  };
}

// An image post: post_hint=image + i.redd.it url → mediaType "image" → thumbnailUrl
// derived from the url (12-SPIKE #2 — thumbnail field absent, derived by presence).
function imagePost(shortId: string, daysAgo: number, author: string, imgUrl: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit: "gamedev",
    title: `Screenshot ${shortId}`,
    selftext: "",
    score: 87,
    num_comments: 12,
    post_hint: "image",
    url: imgUrl,
    domain: "i.redd.it",
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/gamedev/comments/${shortId}/screenshot/`,
  };
}

async function seedAccountSource(handle: string): Promise<{ userId: string; sourceId: string }> {
  const u = await seedUserDirectly({ email: `rdt-viz-${uniq()}@t.io` });
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

async function runBackfill(userId: string, handle: string): Promise<void> {
  await handleBackfillAccount({
    data: {
      kind: "reddit_account",
      channelKey: handle,
      triggerUserId: userId,
      depthBoundIso: "1970-01-01T00:00:00Z",
      flow: "incremental",
    },
  });
}

beforeEach(() => {
  provider.pages = [];
});

describe("reddit feed inbox + metric series (VIZ-05 + PLAT-04)", () => {
  it("[12-06] a backfill tick imports reddit_posts into the /feed inbox and enriches them with likes + comments (+ thumbnail on an image post, null on a self post)", async () => {
    const handle = `viz_${uniq()}`;
    const selfId = `s${uniq()}`;
    const imgId = `i${uniq()}`;
    const imgUrl = `https://i.redd.it/${imgId}.jpg`;
    const { userId, sourceId } = await seedAccountSource(handle);
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [selfPost(selfId, 1, handle), imagePost(imgId, 2, handle, imgUrl)],
        after: null,
      }),
    ];

    await runBackfill(userId, handle);

    const ids = [`t3_${selfId}`, `t3_${imgId}`];
    const evs = await db.select().from(events).where(inArray(events.externalId, ids));
    expect(evs).toHaveLength(2);
    expect(evs.every((e) => e.kind === "reddit_post")).toBe(true);
    // Inbox criterion: source_id set, no attached games.
    expect(evs.every((e) => e.sourceId === sourceId)).toBe(true);
    for (const ev of evs) {
      const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev.id));
      expect(junction).toHaveLength(0);
    }

    // The /feed enrichment surfaces the snapshot the walker wrote.
    const dtos = await mapEventsToDtos(userId, evs);
    await redditEnrichFeedDtos(userId, dtos);
    type RedditDto = {
      externalId: string | null;
      redditEnrichment?: {
        stats: { likeCount: number | null; commentCount: number | null } | null;
        thumbnailUrl: string | null;
        mediaType: string | null;
      };
    };
    const byId = new Map(
      (dtos as unknown as RedditDto[]).map((d) => [d.externalId as string, d]),
    );
    const selfDto = byId.get(`t3_${selfId}`)!;
    const imgDto = byId.get(`t3_${imgId}`)!;

    // Likes + comments by presence — NO views, NO shares fields on the enrichment.
    expect(selfDto.redditEnrichment?.stats?.likeCount).toBe(11);
    expect(selfDto.redditEnrichment?.stats?.commentCount).toBe(4);
    // A self/text post has NO derivable thumbnail (mediaType "self").
    expect(selfDto.redditEnrichment?.mediaType).toBe("self");
    expect(selfDto.redditEnrichment?.thumbnailUrl).toBeNull();

    // The image post carries the raw i.redd.it hotlink (derived by presence).
    expect(imgDto.redditEnrichment?.stats?.likeCount).toBe(87);
    expect(imgDto.redditEnrichment?.stats?.commentCount).toBe(12);
    expect(imgDto.redditEnrichment?.mediaType).toBe("image");
    expect(imgDto.redditEnrichment?.thumbnailUrl).toBe(imgUrl);
  });

  it("[12-06] attach an imported reddit_post to a game → the metric series renders likes + comments on /games/[id] (VIZ-05/PLAT-04)", async () => {
    const handle = `viz_${uniq()}`;
    const postId = `s${uniq()}`;
    const { userId } = await seedAccountSource(handle);
    provider.pages = [
      normalizeRedditFeed({ success: true, posts: [selfPost(postId, 2, handle)], after: null }),
    ];
    await runBackfill(userId, handle);

    const [ev] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.externalId, `t3_${postId}`),
          isNull(events.deletedAt),
        ),
      )
      .limit(1);
    expect(ev).toBeDefined();
    // A snapshot exists (the series source).
    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${postId}`));
    expect(snaps.length).toBeGreaterThanOrEqual(1);

    const game = await createGame(userId, { title: "My Reddit-promoted game" }, "127.0.0.1");
    await attachEventToGames(userId, ev!.id, [game.id], "127.0.0.1");
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(1);

    // The /games/[id] chart path: getEventMetricSeries gates on getEventById (tenant
    // 404) then iterates allAdapters → redditFetchEventMetricSeries. D-09: exactly TWO
    // series (like_count + comment_count) — NO view_count, NO share_count.
    const series = await getEventMetricSeries(userId, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count"]);
    expect(keys).not.toContain("view_count");
    expect(keys).not.toContain("share_count");
    const likes = series.find((s) => s.metricKey === "like_count");
    expect(likes!.labelKey).toBe("chart_metric_likes");
    expect(likes!.points.at(-1)!.value).toBe(11);
    const comments = series.find((s) => s.metricKey === "comment_count");
    expect(comments!.points.at(-1)!.value).toBe(4);
  });

  it("[12-06] the chart event-marker resolves the reddit thumbnail via the redditEnrichment seam (image post → i.redd.it hotlink; self post → null)", async () => {
    const handle = `viz_${uniq()}`;
    const imgId = `i${uniq()}`;
    const imgUrl = `https://i.redd.it/${imgId}.png`;
    const { userId } = await seedAccountSource(handle);
    provider.pages = [
      normalizeRedditFeed({
        success: true,
        posts: [imagePost(imgId, 1, handle, imgUrl)],
        after: null,
      }),
    ];
    await runBackfill(userId, handle);

    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.externalId, `t3_${imgId}`)))
      .limit(1);
    const [dto] = await mapEventsToDtos(userId, [ev!]);
    await redditEnrichFeedDtos(userId, [dto!]);

    // eventThumbnail reads redditEnrichment.thumbnailUrl (the SAME seam the feed card
    // uses) — the raw i.redd.it hotlink, NO proxy (12-SPIKE Pitfall 5).
    expect(eventThumbnail(dto as never)).toBe(imgUrl);

    // A self/text post → no derivable thumbnail → the marker falls back to the
    // kind-colored placeholder (null).
    const selfId = `s${uniq()}`;
    provider.pages = [
      normalizeRedditFeed({ success: true, posts: [selfPost(selfId, 1, handle)], after: null }),
    ];
    await runBackfill(userId, handle);
    const [selfEv] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), eq(events.externalId, `t3_${selfId}`)))
      .limit(1);
    const [selfDto] = await mapEventsToDtos(userId, [selfEv!]);
    await redditEnrichFeedDtos(userId, [selfDto!]);
    expect(eventThumbnail(selfDto as never)).toBeNull();
  });
});

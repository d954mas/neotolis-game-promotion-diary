// PROFILE posts (`/user/<name>/comments/<id>`) — review P1, re-pointed at the
// DETAIL endpoint (12-06 UAT).
//
// Reddit files a profile self-post under the pseudo-subreddit `u_<name>`. The original
// bug: the URL parser read the `/user/` root as a plain subreddit NAME, so a profile
// post never resolved — the paste preview degraded to "unavailable" while still spending
// a credit + a cap slot, and "Refresh now" wrote a not_found snapshot forever.
//
// WHAT CHANGED: by-URL resolution no longer goes through the subreddit FEED
// (`?subreddit=<slug>` + a page-1 scan). `fetchPostByUrl` now calls the single-post
// DETAIL endpoint `/v1/reddit/post/comments?url=<full post URL>&trim=true` (1 credit),
// which resolves the exact post — so a null means the post is GONE, not "not on page 1".
// The outbound request therefore carries NO `subreddit` param at all: the whole post URL
// is the key, and the subreddit identity comes back IN the response. These tests moved
// with it — the invariant they defend is unchanged (a `/user/` post must resolve, and its
// cached identity must be `u_<name>` while a community post keeps its plain slug), but it
// is now asserted on the URL we send + the identity we persist, not on a query param that
// no longer exists.
//
// This file drives the REAL provider + the REAL URL builder and mocks only the HTTP seam
// (redditFetch), so the assertion is the actual outbound request. Both money paths are
// covered: the paste preview (adapter.fetchEventPreviewMetadata) and the per-post refresh
// lane (redditRefreshQueueTick → resolvePermalink → provider.fetchPostByUrl).
//
// Requirements: PLAT-04 / D-01.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

/** Every outbound ScrapeCreators URL this test captured, in order. */
const requests: URL[] = [];
/** The envelope the mocked HTTP seam replies with. The DETAIL endpoint answers
 *  `{success, post}` (single object) — NOT the feed's `{success, posts[], after}`. */
let responseBody: unknown = { success: true, post: null };
let spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };

vi.mock("../../src/lib/sources/reddit/server/http.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Capture the URL the provider built and skip the network + credit reservation
    // (budget behavior is covered by reddit-budget-key / reddit-paste-preview).
    redditFetch: async (url: URL): Promise<Response> => {
      requests.push(new URL(url.toString()));
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { scrapeCreatorsRedditProvider } =
    await import("../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js");
  return {
    ...actual,
    isRedditConfigured: () => true,
    // The REAL provider — the point of this file is the URL it builds.
    getSocialProvider: (platform: string) =>
      platform === "reddit" ? (scrapeCreatorsRedditProvider as never) : null,
  };
});

vi.mock("../../src/lib/sources/reddit/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialProviderSpendToday: async () => spend };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { redditPosts, redditPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
const { redditRefreshQueueTick, __resetRedditRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/reddit/server/handlers/refresh-queue-tick.js");

const uniq = (): string => Math.random().toString(36).slice(2, 8);

/** A ScrapeCreators post body for the given short id / author / subreddit. */
function providerPost(shortId: string, author: string, subreddit: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit,
    title: "Profile devlog",
    selftext: "the body",
    score: 11,
    num_comments: 3,
    created_utc: Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000),
    permalink: `/user/${author}/comments/${shortId}/profile_devlog/`,
  };
}

beforeEach(() => {
  requests.length = 0;
  responseBody = { success: true, post: null };
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
  __resetRedditRefreshQueueWorkerForTest();
});

describe("reddit profile posts (/user/<name>/comments/<id>)", () => {
  it("[review-P1] the paste PREVIEW resolves a profile post via the u_<name> pseudo-subreddit", async () => {
    const u = await seedUserDirectly({ email: `rdt-prof-preview-${uniq()}@t.io` });
    const author = `Prof${uniq()}`;
    const shortId = `pp${uniq()}`;
    const url = `https://www.reddit.com/user/${author}/comments/${shortId}/profile_devlog/`;
    responseBody = { success: true, post: providerPost(shortId, author, `u_${author}`) };

    const preview = await redditAdapter.fetchEventPreviewMetadata!(url, {
      userId: u.id,
      ipAddress: "127.0.0.1",
    });

    expect(requests, "exactly one provider request").toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/reddit/post/comments");
    // The whole post URL is the key — the `/user/` permalink is passed THROUGH,
    // never rewritten into an `r/<name>` form (that rewrite was the original bug,
    // and it would now resolve a different post or nothing at all).
    expect(requests[0]!.searchParams.get("url"), "the profile permalink, verbatim").toBe(url);
    // trim=true keeps the (unused) comment tree out of the paid response body.
    expect(requests[0]!.searchParams.get("trim")).toBe("true");
    // The feed-only params must NOT leak onto the detail endpoint.
    expect(requests[0]!.searchParams.get("subreddit")).toBeNull();
    expect(requests[0]!.searchParams.get("timeframe")).toBeNull();

    expect(preview.kind).toBe("ok");
    if (preview.kind !== "ok") throw new Error("unreachable");
    expect(preview.title).toBe("Profile devlog");
    expect(preview.externalId).toBe(`t3_${shortId}`);
    expect(preview.occurredAt?.toISOString(), "occurredAt comes from created_utc").toBe(
      "2026-06-01T12:00:00.000Z",
    );
    // The PERSISTED identity is the pseudo-subreddit from the response — this is what
    // the feed card, the metric series, and any later walk agree on.
    const [cached] = await db
      .select({ slug: redditPosts.subredditSlug })
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${shortId}`));
    expect(cached!.slug, "profile posts live under u_<name>").toBe(`u_${author.toLowerCase()}`);
  });

  it("[review-P1] the per-post REFRESH lane resolves a cached profile permalink through the detail endpoint", async () => {
    const u = await seedUserDirectly({ email: `rdt-prof-refresh-${uniq()}@t.io` });
    const author = `Prof${uniq()}`;
    const shortId = `pr${uniq()}`;
    const url = `https://www.reddit.com/user/${author}/comments/${shortId}/profile_devlog/`;
    await db.insert(redditPosts).values({
      postId: `t3_${shortId}`,
      subredditSlug: `u_${author.toLowerCase()}`,
      permalink: url,
      author,
      authorFullname: `t2_${author}`,
      title: "Profile devlog",
      publishedAt: new Date("2026-06-01T12:00:00Z"),
      lastPolledAt: new Date("2026-06-02T00:00:00Z"),
      lastPollStatus: "ok",
    });
    const event = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Profile devlog",
        occurredAt: new Date("2026-06-02T00:00:00Z"),
        url,
        gameIds: [],
      },
      "127.0.0.1",
    );
    expect(event.externalId, "the t3 id is re-derived from the URL").toBe(`t3_${shortId}`);
    // createEvent's own enrichment may have issued a provider request — the lane's request
    // is what this test asserts, so start counting from here.
    requests.length = 0;
    responseBody = { success: true, post: providerPost(shortId, author, `u_${author}`) };

    await redditAdapter.refreshQueue!.enqueue({
      eventId: event.id,
      userId: u.id,
      externalId: `t3_${shortId}`,
      eventKind: "reddit_post",
    });
    await redditRefreshQueueTick();

    expect(requests, "the lane issued exactly one provider request").toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/reddit/post/comments");
    // The lane resolves the fetch URL from the CACHED permalink (the profile form),
    // so a profile post is refreshable without the caller supplying a URL.
    expect(requests[0]!.searchParams.get("url")).toBe(url);

    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${shortId}`));
    expect(snaps, "the refresh resolved the post and wrote a snapshot").toHaveLength(1);
    expect(snaps[0]!.likeCount).toBe(11);
    expect(snaps[0]!.commentCount).toBe(3);
  });

  it("[review-P1] a COMMUNITY post still resolves under its plain slug (no u_ prefix regression)", async () => {
    const u = await seedUserDirectly({ email: `rdt-prof-comm-${uniq()}@t.io` });
    const shortId = `cm${uniq()}`;
    responseBody = { success: true, post: providerPost(shortId, `dev${uniq()}`, "gamedev") };
    const url = `https://www.reddit.com/r/GameDev/comments/${shortId}/x/`;

    const preview = await redditAdapter.fetchEventPreviewMetadata!(url, {
      userId: u.id,
      ipAddress: "127.0.0.1",
    });

    expect(preview.kind).toBe("ok");
    // The pasted community permalink is what gets sent (case preserved by the URL
    // canonicalizer's lowercasing upstream — the adapter forwards what it is given).
    expect(requests[0]!.pathname).toBe("/v1/reddit/post/comments");
    expect(requests[0]!.searchParams.get("url")).toBe(url);
    // The persisted slug stays PLAIN — the u_ prefix belongs to profile posts only.
    const [cached] = await db
      .select({ slug: redditPosts.subredditSlug })
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${shortId}`));
    expect(cached!.slug, "a community post must never gain a u_ prefix").toBe("gamedev");
  });
});

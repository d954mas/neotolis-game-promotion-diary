// PROFILE posts (`/user/<name>/comments/<id>`) — review P1.
//
// Reddit files a profile self-post under the pseudo-subreddit `u_<name>`, and
// ScrapeCreators' only by-id-capable endpoint is the subreddit feed. Pre-fix the URL
// parser read the `/user/` root as a plain subreddit NAME, so BOTH by-URL paths asked the
// provider for `?subreddit=<name>` — the unrelated r/<name> community (or a 404) — and the
// post never resolved: the paste preview always degraded to "unavailable" while still
// spending a credit + a per-user cap slot, and "Refresh now" on a profile post silently
// wrote a not_found snapshot forever.
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
/** The envelope the mocked HTTP seam replies with. */
let responseBody: unknown = { success: true, posts: [], after: null };
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
  responseBody = { success: true, posts: [], after: null };
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
  __resetRedditRefreshQueueWorkerForTest();
});

describe("reddit profile posts (/user/<name>/comments/<id>)", () => {
  it("[review-P1] the paste PREVIEW resolves a profile post via the u_<name> pseudo-subreddit", async () => {
    const u = await seedUserDirectly({ email: `rdt-prof-preview-${uniq()}@t.io` });
    const author = `Prof${uniq()}`;
    const shortId = `pp${uniq()}`;
    const url = `https://www.reddit.com/user/${author}/comments/${shortId}/profile_devlog/`;
    responseBody = {
      success: true,
      posts: [providerPost(shortId, author, `u_${author}`)],
      after: null,
    };

    const preview = await redditAdapter.fetchEventPreviewMetadata!(url, {
      userId: u.id,
      ipAddress: "127.0.0.1",
    });

    expect(requests, "exactly one provider request").toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/reddit/subreddit");
    expect(
      requests[0]!.searchParams.get("subreddit"),
      "the profile pseudo-subreddit, NOT the bare username",
    ).toBe(`u_${author.toLowerCase()}`);

    expect(preview.kind).toBe("ok");
    if (preview.kind !== "ok") throw new Error("unreachable");
    expect(preview.title).toBe("Profile devlog");
    expect(preview.externalId).toBe(`t3_${shortId}`);
    expect(preview.occurredAt?.toISOString(), "occurredAt comes from created_utc").toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  it("[review-P1] the per-post REFRESH lane fetches a cached profile permalink from the same u_<name> feed", async () => {
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
    responseBody = {
      success: true,
      posts: [providerPost(shortId, author, `u_${author}`)],
      after: null,
    };

    await redditAdapter.refreshQueue!.enqueue({
      eventId: event.id,
      userId: u.id,
      externalId: `t3_${shortId}`,
      eventKind: "reddit_post",
    });
    await redditRefreshQueueTick();

    expect(requests, "the lane issued exactly one provider request").toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/v1/reddit/subreddit");
    expect(requests[0]!.searchParams.get("subreddit")).toBe(`u_${author.toLowerCase()}`);

    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${shortId}`));
    expect(snaps, "the refresh resolved the post and wrote a snapshot").toHaveLength(1);
    expect(snaps[0]!.likeCount).toBe(11);
    expect(snaps[0]!.commentCount).toBe(3);
  });

  it("[review-P1] a COMMUNITY post still resolves via its plain slug (no u_ prefix regression)", async () => {
    const u = await seedUserDirectly({ email: `rdt-prof-comm-${uniq()}@t.io` });
    const shortId = `cm${uniq()}`;
    responseBody = {
      success: true,
      posts: [providerPost(shortId, `dev${uniq()}`, "gamedev")],
      after: null,
    };

    await redditAdapter.fetchEventPreviewMetadata!(
      `https://www.reddit.com/r/GameDev/comments/${shortId}/x/`,
      { userId: u.id, ipAddress: "127.0.0.1" },
    );

    expect(requests[0]!.searchParams.get("subreddit")).toBe("gamedev");
  });
});

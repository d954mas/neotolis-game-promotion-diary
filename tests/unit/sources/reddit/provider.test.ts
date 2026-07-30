import { beforeEach, describe, expect, it, vi } from "vitest";

const redditFetch = vi.fn();

vi.mock("../../../../src/lib/sources/reddit/server/http.js", () => ({
  redditFetch: (...args: unknown[]) => redditFetch(...args),
}));

const { scrapeCreatorsRedditProvider } =
  await import("../../../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js");

function detailPost(shortId: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author: "maker",
    author_fullname: "t2_maker",
    subreddit: "gamedev",
    title: "Devlog",
    selftext: "Body",
    score: 4,
    num_comments: 2,
    created_utc: 1_767_225_600,
    permalink: `/r/gamedev/comments/${shortId}/devlog/`,
    url: `https://www.reddit.com/r/gamedev/comments/${shortId}/devlog/`,
  };
}

function respondWith(post: unknown): void {
  redditFetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, post }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  redditFetch.mockReset();
});

describe("ScrapeCreators Reddit post-detail identity", () => {
  it("rejects a valid but different post than the one requested", async () => {
    respondWith(detailPost("other1"));

    await expect(
      scrapeCreatorsRedditProvider.fetchPostByUrl(
        "reddit",
        "https://www.reddit.com/r/gamedev/comments/wanted1/devlog/",
        { origin: "cron" },
      ),
    ).rejects.toMatchObject({ category: "transient" });
  });

  it("resolves Reddit's subreddit-less /comments/<id> canonical URL", async () => {
    respondWith(detailPost("bare1"));

    const post = await scrapeCreatorsRedditProvider.fetchPostByUrl(
      "reddit",
      "https://www.reddit.com/comments/bare1",
      { origin: "cron" },
    );

    expect(post?.id).toBe("t3_bare1");
    expect(redditFetch).toHaveBeenCalledOnce();
  });

  it("preserves removed_by_category as post-level deletion evidence", async () => {
    respondWith({ ...detailPost("removed1"), removed_by_category: "moderator" });

    const post = await scrapeCreatorsRedditProvider.fetchPostByUrl(
      "reddit",
      "https://www.reddit.com/r/gamedev/comments/removed1/devlog/",
      { origin: "cron" },
    );

    expect(post?.removedByCategory).toBe("moderator");
  });

  it("keeps redd.it short links recognition-only", async () => {
    await expect(
      scrapeCreatorsRedditProvider.fetchPostByUrl("reddit", "https://redd.it/short1", {
        origin: "cron",
      }),
    ).resolves.toBeNull();
    expect(redditFetch).not.toHaveBeenCalled();
  });
});

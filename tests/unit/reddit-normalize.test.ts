// Reddit feed-envelope belts (Phase 12 review fixes).
//
// Two provider-shape anomalies must NEVER read as an authoritative empty feed,
// because the walker treats a complete zero-post pass on an established source as
// "the subject deleted ALL posts" (reconcileAllDisappeared → the 48h GDPR purge
// clock on every tracked row):
//   1. success:true with the posts[] field ABSENT → AdapterError(transient).
//   2. a non-t3 row (t1 comment / t5 subreddit) → per-row drop (mapPostsResilient),
//      never a cached/imported post under a bogus externalId.
//
// Pure unit test — no DB, no live HTTP.
import { describe, it, expect } from "vitest";
import {
  normalizeRedditFeed,
  normalizeRedditPost,
  normalizeRedditPostDetail,
} from "$lib/sources/reddit/server/normalize.js";
import { AdapterError } from "$lib/sources/errors.js";

function post(id: string, name = `t3_${id}`) {
  return {
    name,
    id,
    author: "d954mas",
    subreddit: "gamedev",
    title: `Devlog ${id}`,
    score: 1,
    num_comments: 0,
    created_utc: 1_750_000_000,
    permalink: `/r/gamedev/comments/${id}/x/`,
  };
}

describe("normalizeRedditFeed envelope belts (review fixes)", () => {
  it("success:true with posts[] ABSENT throws transient — never an authoritative empty feed", () => {
    for (const envelope of [
      { success: true, after: null },
      { success: true, posts: null },
    ]) {
      try {
        normalizeRedditFeed(envelope);
        expect.fail("expected AdapterError for a posts-less success envelope");
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).category).toBe("transient");
      }
    }
  });

  it("a PRESENT-but-empty posts[] stays the authoritative empty feed (end-of-feed)", () => {
    const page = normalizeRedditFeed({ success: true, posts: [], after: null });
    expect(page.posts).toHaveLength(0);
    expect(page.endOfFeed).toBe(true);
    expect(page.droppedCount).toBe(0);
  });

  it("success:false still throws transient (soft-error page served as HTTP 200)", () => {
    expect(() => normalizeRedditFeed({ success: false, posts: [], after: null })).toThrowError(
      AdapterError,
    );
  });

  it("a non-t3 fullname row is DROPPED (identity belt), surviving rows keep the page lossy-marked", () => {
    const page = normalizeRedditFeed({
      success: true,
      posts: [post("aaa"), post("bbb", "t1_bbb"), post("ccc")],
      after: null,
    });
    expect(page.posts.map((p) => p.id)).toEqual(["t3_aaa", "t3_ccc"]);
    // droppedCount is the walker's lossy-pass signal — the reconcile suppressor.
    expect(page.droppedCount).toBe(1);
  });

  it("drops empty, mismatched, and non-base36 Reddit fullname identities", () => {
    const page = normalizeRedditFeed({
      success: true,
      posts: [
        post("aaa"),
        post("", "t3_"),
        post("bbb", "t3_aaa"),
        post("not-valid", "t3_not-valid"),
        post("ccc"),
        post("ddd"),
        post("eee"),
      ],
      after: null,
    });

    expect(page.posts.map((item) => item.id)).toEqual(["t3_aaa", "t3_ccc", "t3_ddd", "t3_eee"]);
    expect(page.droppedCount).toBe(3);
  });
});

// Provider-owned URLs land in href (permalink) and img src (thumbnail), so the
// boundary must reject arbitrary hosts (review-P2): HTTPS + reddit.com family for
// permalinks, HTTPS + the redd.it / redditmedia.com CDN families for thumbnails.
describe("provider URL boundary validation (review-P2)", () => {
  it("permalink: a path is prefixed; an https reddit.com absolute survives; foreign/insecure hosts → null", () => {
    expect(normalizeRedditPost(post("aaa")).permalink).toBe(
      "https://www.reddit.com/r/gamedev/comments/aaa/x/",
    );
    expect(
      normalizeRedditPost({
        ...post("bbb"),
        permalink: "https://old.reddit.com/r/gamedev/comments/bbb/x/",
      }).permalink,
    ).toBe("https://old.reddit.com/r/gamedev/comments/bbb/x/");
    for (const bad of [
      "https://evil.example.com/r/gamedev/comments/ccc/x/",
      "http://www.reddit.com/r/gamedev/comments/ccc/x/", // not HTTPS
      "https://notreddit.com/r/gamedev/comments/ccc/x/",
      "https://evilreddit.com/x/", // suffix-spoof: not reddit.com nor *.reddit.com
    ]) {
      expect(normalizeRedditPost({ ...post("ccc"), permalink: bad }).permalink, bad).toBeNull();
    }
  });

  it("thumbnail: derived i.redd.it image url survives; an external image host is dropped (no third-party hotlink)", () => {
    const image = (url: string) => ({
      ...post("ddd"),
      selftext: "",
      post_hint: "image",
      url,
    });
    expect(normalizeRedditPost(image("https://i.redd.it/abc.jpg")).thumbnailUrl).toBe(
      "https://i.redd.it/abc.jpg",
    );
    expect(normalizeRedditPost(image("https://i.imgur.com/abc.jpg")).thumbnailUrl).toBeNull();
    expect(normalizeRedditPost(image("http://i.redd.it/abc.jpg")).thumbnailUrl).toBeNull();
  });

  it("linkDomain: a LINK post carries the destination domain — provider field first, lowercased", () => {
    // Subreddit-endpoint shape: post_hint + domain present.
    expect(
      normalizeRedditPost({
        ...post("fff"),
        post_hint: "link",
        domain: "YouTube.com",
        url: "https://www.youtube.com/watch?v=x",
      }).linkDomain,
    ).toBe("youtube.com");
  });

  it("linkDomain: without the provider domain field (author-search shape) the url hostname is derived", () => {
    // author-search omits post_hint + domain — an external https url + empty
    // selftext classifies as a link post; the hostname is derived + lowercased.
    const derived = normalizeRedditPost({
      ...post("ggg"),
      selftext: "",
      url: "https://Store.SteamPowered.com/app/123/",
    });
    expect(derived.mediaType).toBe("link");
    expect(derived.linkDomain).toBe("store.steampowered.com");
  });

  it("linkDomain: null for every non-link form (self / image)", () => {
    const self = normalizeRedditPost({
      ...post("hhh"),
      selftext: "the body",
      url: "https://www.reddit.com/r/gamedev/comments/hhh/x/",
    });
    expect(self.mediaType).toBe("self");
    expect(self.linkDomain).toBeNull();

    const image = normalizeRedditPost({
      ...post("iii"),
      selftext: "",
      post_hint: "image",
      url: "https://i.redd.it/abc.jpg",
    });
    expect(image.mediaType).toBe("image");
    expect(image.linkDomain).toBeNull();
  });

  it("mediaType: the EVIDENCE-FREE author-search shape is UNKNOWN (null), never a false self (12-06 UAT cat-photo finding)", () => {
    // The author-search endpoint omits post_hint + domain and its url is just the
    // comments permalink — an IMAGE post is byte-identical to a text post there.
    // A false "self" sticks forever (COALESCE-preserve); NULL lets a richer write
    // (subreddit walk / paste / Refresh-Now) upgrade the form in place.
    const unknown = normalizeRedditPost({
      ...post("mmm"),
      url: "https://www.reddit.com/r/Catmemes/comments/mmm/she_chose_her_cape/",
    });
    expect(unknown.mediaType, "no media evidence → form unknown").toBeNull();
    expect(unknown.kind, "renders as text until enriched").toBe("text");
    expect(unknown.thumbnailUrl).toBeNull();
    expect(unknown.linkDomain).toBeNull();

    // selftext present IS positive text evidence — still classifies self.
    const self = normalizeRedditPost({
      ...post("nnn"),
      selftext: "the body",
      url: "https://www.reddit.com/r/gamedev/comments/nnn/x/",
    });
    expect(self.mediaType).toBe("self");
  });

  it("post-detail envelope: the true url resolves the real form; success:false throws; missing post → null", () => {
    // /post/comments returns the post's TRUE url (media/destination), so the
    // standard derivation resolves what the author-search shape could not.
    const detail = normalizeRedditPostDetail({
      success: true,
      post: { ...post("ooo"), selftext: null, url: "https://i.redd.it/cat.png" },
    });
    expect(detail!.mediaType).toBe("image");
    expect(detail!.thumbnailUrl).toBe("https://i.redd.it/cat.png");

    expect(() => normalizeRedditPostDetail({ success: false })).toThrowError(AdapterError);
    expect(normalizeRedditPostDetail({ success: true, post: null }), "post gone → null").toBeNull();
    expect(
      normalizeRedditPostDetail({ success: true, post: { garbage: true } }),
      "malformed post object → unresolvable, not a transport fault",
    ).toBeNull();
  });

  it("linkDomain: an unparseable or non-http(s) url on a link post yields null (domain-only, no href surface)", () => {
    expect(
      normalizeRedditPost({ ...post("jjj"), selftext: "", url: "not a url" }).linkDomain,
    ).toBeNull();
    expect(
      normalizeRedditPost({ ...post("kkk"), selftext: "", url: "ftp://example.com/file" })
        .linkDomain,
    ).toBeNull();
  });

  it("thumbnail: the forward-compat `thumbnail` field is honored only on the Reddit CDN over HTTPS", () => {
    const withThumb = (thumbnail: string) => ({ ...post("eee"), thumbnail });
    expect(
      normalizeRedditPost(withThumb("https://b.thumbs.redditmedia.com/x.jpg")).thumbnailUrl,
    ).toBe("https://b.thumbs.redditmedia.com/x.jpg");
    expect(normalizeRedditPost(withThumb("https://preview.redd.it/x.png")).thumbnailUrl).toBe(
      "https://preview.redd.it/x.png",
    );
    expect(
      normalizeRedditPost(withThumb("https://tracking.example.com/x.png")).thumbnailUrl,
    ).toBeNull();
  });
});

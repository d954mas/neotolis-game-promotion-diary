// Reddit URL parsing unit tests (Phase 03.1 DV-RDT-7).
//
// Two parsers under test:
//   - redditParsePostUrl   — event paste flow; `/r/<sub>/comments/<id>/...`
//                            and `redd.it/<id>` short-link. V6 + V7 invariants.
//   - redditParseSourceUrl — /sources/new auto-detect; `/r/X` → subreddit,
//                            `/user/X` (and `/u/X` short form) → account.
//                            D-RDT-PARSE-SOURCE.
//
// Both parsers host-check FIRST (V7) — `example.com/r/X/comments/Y` returns
// null, not a false-positive Reddit event.
//
// Both parsers also LOWERCASE the subreddit / username identifier on
// output. Reddit treats `r/IndieDev` and `r/indiedev` as the same
// subreddit; the public-data caches key on lowercase so two subscribers
// pasting different-case spellings collapse to the same cache row +
// fan-out lane. The tests below assert lowercase on every parsed
// identifier including the mixed-case "IndieDev" inputs.

import { describe, it, expect } from "vitest";
import { redditParsePostUrl, redditParseSourceUrl } from "$lib/sources/reddit/server/url.js";

describe("redditParsePostUrl (V6 — 5 URL shapes + V7 host-check-first)", () => {
  it("V6: reddit.com/r/X/comments/Y", () => {
    expect(redditParsePostUrl("https://reddit.com/r/IndieDev/comments/abc123/title")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: "indiedev" },
    });
  });

  it("V6: old.reddit.com", () => {
    expect(redditParsePostUrl("https://old.reddit.com/r/IndieDev/comments/abc123/")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: "indiedev" },
    });
  });

  it("V6: m.reddit.com mobile host", () => {
    expect(redditParsePostUrl("https://m.reddit.com/r/IndieDev/comments/abc123")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: "indiedev" },
    });
  });

  it("V6: www.reddit.com", () => {
    expect(redditParsePostUrl("https://www.reddit.com/r/IndieDev/comments/abc123/title")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: "indiedev" },
    });
  });

  it("V6: redd.it short link (subreddit unknown until fetched)", () => {
    expect(redditParsePostUrl("https://redd.it/abc123")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: null },
    });
  });

  it("V7 host-check FIRST: example.com/r/IndieDev/comments/abc123 → null", () => {
    expect(redditParsePostUrl("https://example.com/r/IndieDev/comments/abc123/title")).toBeNull();
  });

  it("source URL (no /comments/ segment) on parsePostUrl → null", () => {
    expect(redditParsePostUrl("https://reddit.com/user/foo")).toBeNull();
  });

  it("malformed input returns null (URL parse fails gracefully)", () => {
    expect(redditParsePostUrl("malformed input")).toBeNull();
  });

  it("upper-case subreddit input normalized to lowercase", () => {
    expect(redditParsePostUrl("https://www.reddit.com/r/INDIEDEV/comments/abc123/title")).toEqual({
      kind: "reddit_post",
      externalId: "abc123",
      metadata: { subreddit: "indiedev" },
    });
  });
});

describe("redditParseSourceUrl (D-RDT-PARSE-SOURCE)", () => {
  it("reddit.com/r/X → reddit_subreddit (handle lowercased)", () => {
    expect(redditParseSourceUrl("https://reddit.com/r/IndieDev")).toEqual({
      kind: "reddit_subreddit",
      handle: "indiedev",
      externalUrl: "https://www.reddit.com/r/indiedev",
    });
  });

  it("reddit.com/user/X → reddit_account (handle lowercased)", () => {
    expect(redditParseSourceUrl("https://reddit.com/user/D954mas")).toEqual({
      kind: "reddit_account",
      handle: "d954mas",
      externalUrl: "https://www.reddit.com/user/d954mas",
    });
  });

  it("reddit.com/u/X (short /u/ form) → reddit_account", () => {
    expect(redditParseSourceUrl("https://reddit.com/u/d954mas")).toEqual({
      kind: "reddit_account",
      handle: "d954mas",
      externalUrl: "https://www.reddit.com/user/d954mas",
    });
  });

  it("raw r/X prefix (no scheme) → reddit_subreddit, lowercased + canonical URL", () => {
    expect(redditParseSourceUrl("r/IndieDev")).toEqual({
      kind: "reddit_subreddit",
      handle: "indiedev",
      externalUrl: "https://www.reddit.com/r/indiedev",
    });
  });

  it("raw u/X prefix (no scheme) → reddit_account, lowercased + canonical URL", () => {
    expect(redditParseSourceUrl("u/D954mas")).toEqual({
      kind: "reddit_account",
      handle: "d954mas",
      externalUrl: "https://www.reddit.com/user/d954mas",
    });
  });

  it("post URL on parseSourceUrl returns null (caller likely meant parseUrl)", () => {
    expect(redditParseSourceUrl("https://reddit.com/r/IndieDev/comments/abc123")).toBeNull();
  });

  it("bare name returns null (ambiguous — could be sub OR user)", () => {
    expect(redditParseSourceUrl("IndieDev")).toBeNull();
  });

  it("V7 host-check FIRST: example.com/r/IndieDev → null", () => {
    expect(redditParseSourceUrl("https://example.com/r/IndieDev")).toBeNull();
  });

  it("old.reddit.com source URL → still parsed correctly + lowercased", () => {
    expect(redditParseSourceUrl("https://old.reddit.com/user/FOO")).toEqual({
      kind: "reddit_account",
      handle: "foo",
      externalUrl: "https://www.reddit.com/user/foo",
    });
  });

  it("malformed input returns null", () => {
    expect(redditParseSourceUrl("not-a-url-or-prefix-shape")).toBeNull();
  });

  it("reddit.com/r/X/ (trailing slash) → reddit_subreddit + lowercase", () => {
    expect(redditParseSourceUrl("https://reddit.com/r/IndieDev/")).toEqual({
      kind: "reddit_subreddit",
      handle: "indiedev",
      externalUrl: "https://www.reddit.com/r/indiedev",
    });
  });

  it("ALL-CAPS subreddit → lowercased", () => {
    expect(redditParseSourceUrl("R/INDIEDEV")).toEqual({
      kind: "reddit_subreddit",
      handle: "indiedev",
      externalUrl: "https://www.reddit.com/r/indiedev",
    });
  });
});

// Carry-over Reddit URL parsers, flipped live by Plan 12-03. Host-check-FIRST +
// raw-prefix-before-new-URL() (#73). The load-bearing invariant: a non-Reddit
// host can NEVER produce a reddit_post / reddit source (T-12-03-T).

import { describe, expect, it } from "vitest";
import { redditParsePostUrl, redditParseSourceUrl } from "$lib/sources/reddit/server/url.js";

describe("reddit url parsing (Phase 12 rebuild)", () => {
  it("[12-03] redditParseSourceUrl: reddit.com/user/<u>, /u/<u>, old./m. hosts, raw u/<u> → reddit_account (lowercase)", () => {
    const cases = [
      "https://reddit.com/user/D954mas",
      "https://www.reddit.com/user/d954mas",
      "https://old.reddit.com/u/D954mas",
      "https://m.reddit.com/u/d954mas",
      "u/D954mas",
      "  u/d954mas/  ",
    ];
    for (const input of cases) {
      const parsed = redditParseSourceUrl(input);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("reddit_account");
      expect(parsed!.handle).toBe("d954mas"); // lowercase-normalized
      expect(parsed!.externalUrl).toBe("https://www.reddit.com/user/d954mas");
    }
  });

  it("[12-03] redditParseSourceUrl: /r/<sub> + raw r/<sub> → reddit_subreddit (lowercase)", () => {
    const cases = [
      "https://reddit.com/r/GameDev",
      "https://www.reddit.com/r/gamedev/",
      "https://old.reddit.com/r/GameDev",
      "r/GameDev",
      "  r/gamedev  ",
    ];
    for (const input of cases) {
      const parsed = redditParseSourceUrl(input);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("reddit_subreddit");
      expect(parsed!.handle).toBe("gamedev");
      expect(parsed!.externalUrl).toBe("https://www.reddit.com/r/gamedev");
    }
  });

  it("[12-03] redditParseSourceUrl: foreign host → null; rejects post URLs + bare names", () => {
    expect(redditParseSourceUrl("https://example.com/r/gamedev")).toBeNull(); // foreign host
    expect(redditParseSourceUrl("https://reddit.com/r/gamedev/comments/abc123/title")).toBeNull(); // post URL
    expect(redditParseSourceUrl("https://reddit.com/user/d954mas/comments/abc/x")).toBeNull(); // profile post
    expect(redditParseSourceUrl("gamedev")).toBeNull(); // bare name, ambiguous
    expect(redditParseSourceUrl("not a url at all")).toBeNull();
  });

  it("[12-03] redditParsePostUrl: /r/<sub>/comments/<id>/<slug?> → reddit_post + subreddit metadata", () => {
    const parsed = redditParsePostUrl(
      "https://www.reddit.com/r/GameDev/comments/1ubhppn/ui_widgets_neotolis_engine/",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("reddit_post");
    expect(parsed!.externalId).toBe("1ubhppn");
    expect(parsed!.metadata?.subreddit).toBe("gamedev"); // lowercase

    // profile self-post form (spike fixture: /user/<u>/comments/<id>)
    const profile = redditParsePostUrl(
      "https://www.reddit.com/user/d954mas/comments/1sw3kot/not_a_trolley_problem/",
    );
    expect(profile).not.toBeNull();
    expect(profile!.kind).toBe("reddit_post");
    expect(profile!.externalId).toBe("1sw3kot");
  });

  it("[12-03] redditParsePostUrl: redd.it/<id> short-link → reddit_post, subreddit null", () => {
    const parsed = redditParsePostUrl("https://redd.it/1ubhppn");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("reddit_post");
    expect(parsed!.externalId).toBe("1ubhppn");
    expect(parsed!.metadata?.subreddit).toBeNull(); // sub not in short-link URL
  });

  it("[12-03] redditParsePostUrl: host-check FIRST — example.com/r/X/comments/Y → null", () => {
    expect(
      redditParsePostUrl("https://example.com/r/gamedev/comments/1ubhppn/title"),
    ).toBeNull();
    expect(redditParsePostUrl("https://reddit.com.evil.com/r/x/comments/y")).toBeNull();
    expect(redditParsePostUrl("garbage")).toBeNull();
  });
});

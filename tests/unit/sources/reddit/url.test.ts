// Carry-over Reddit URL parsers, flipped live by Plan 12-03. Host-check-FIRST +
// raw-prefix-before-new-URL() (#73). The load-bearing invariant: a non-Reddit
// host can NEVER produce a reddit_post / reddit source (T-12-03-T).

import { describe, expect, it } from "vitest";
import {
  redditBuildPermalink,
  redditParsePostUrl,
  redditParseShareUrl,
  redditParseSourceUrl,
} from "$lib/sources/reddit/server/url.js";

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
  });

  it("[review-P1] /user/<name>/comments/<id> resolves the PROFILE pseudo-subreddit u_<name>, never the r/<name> community", () => {
    // Pre-fix the /user/ root was parsed as a plain subreddit name, so the paste preview
    // and the refresh lane both asked the provider for ?subreddit=<name> — the unrelated
    // r/<name> community (or a 404), never the post. Reddit files profile posts under
    // `u_<name>`, which is also the slug the walker caches, so all three paths agree.
    const profile = redditParsePostUrl(
      "https://www.reddit.com/user/D954mas/comments/1sw3kot/not_a_trolley_problem/",
    );
    expect(profile).not.toBeNull();
    expect(profile!.kind).toBe("reddit_post");
    expect(profile!.externalId).toBe("1sw3kot");
    expect(profile!.metadata?.subreddit).toBe("u_d954mas");

    // A literal /r/u_<name> paste (Reddit's own canonical form) must NOT double-prefix.
    const literal = redditParsePostUrl("https://www.reddit.com/r/u_d954mas/comments/1sw3kot/x/");
    expect(literal!.metadata?.subreddit).toBe("u_d954mas");
  });

  it("[review-P2] /comments/<id> (subreddit-less canonical form) parses recognition-only", () => {
    // Produced by the walker's permalink fallback AND by the deletion-propagation purge
    // (which strips /user/<name>/ out of a deleted post's URL). It MUST parse:
    // validateEventInput 422s any reddit_post whose url does not, so an un-parsed form
    // would make every later PATCH of that event fail.
    const parsed = redditParsePostUrl("https://www.reddit.com/comments/1ubhppn");
    expect(parsed).not.toBeNull();
    expect(parsed!.externalId).toBe("1ubhppn");
    expect(parsed!.metadata?.subreddit, "no subreddit in the URL ⇒ recognition-only").toBeNull();
    expect(redditParsePostUrl("https://www.reddit.com/comments/1ubhppn/slug/")!.externalId).toBe(
      "1ubhppn",
    );
  });

  it("[12-03] redditParsePostUrl: redd.it/<id> short-link → reddit_post, subreddit null", () => {
    const parsed = redditParsePostUrl("https://redd.it/1ubhppn");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("reddit_post");
    expect(parsed!.externalId).toBe("1ubhppn");
    expect(parsed!.metadata?.subreddit).toBeNull(); // sub not in short-link URL
  });

  it("[12-03] redditParsePostUrl: host-check FIRST — example.com/r/X/comments/Y → null", () => {
    expect(redditParsePostUrl("https://example.com/r/gamedev/comments/1ubhppn/title")).toBeNull();
    expect(redditParsePostUrl("https://reddit.com.evil.com/r/x/comments/y")).toBeNull();
    expect(redditParsePostUrl("garbage")).toBeNull();
  });

  it("[12-06-s] redditParseShareUrl: /r/<sub>/s/<token> → subreddit hint + normalized share URL (token case preserved)", () => {
    const parsed = redditParseShareUrl(
      "https://www.reddit.com/r/itchio/s/IAnrjbuzIT?utm_source=share",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.subreddit).toBe("itchio");
    // Query junk stripped; the token keeps its case (a case-sensitive redirect key).
    expect(parsed!.canonicalUrl).toBe("https://www.reddit.com/r/itchio/s/IAnrjbuzIT");

    // Profile share → the u_<name> pseudo-subreddit; the pasted root spelling (`u`)
    // survives in the canonical share URL (handed verbatim to Reddit).
    const profile = redditParseShareUrl("https://reddit.com/u/D954mas/s/AbCdEf123/");
    expect(profile).not.toBeNull();
    expect(profile!.subreddit).toBe("u_d954mas");
    expect(profile!.canonicalUrl).toBe("https://www.reddit.com/u/D954mas/s/AbCdEf123");

    // Host-check FIRST; a post permalink / source URL is NOT a share link.
    expect(redditParseShareUrl("https://example.com/r/itchio/s/IAnrjbuzIT")).toBeNull();
    expect(redditParseShareUrl("https://www.reddit.com/r/itchio/comments/abc/x/")).toBeNull();
    expect(redditParseShareUrl("https://www.reddit.com/r/itchio")).toBeNull();
    expect(redditParseShareUrl("garbage")).toBeNull();
  });

  it("[12-06-s] redditParseShareUrl does NOT collide with the source parser (share URL is never a source)", () => {
    expect(redditParseSourceUrl("https://www.reddit.com/r/itchio/s/IAnrjbuzIT")).toBeNull();
    expect(redditParseSourceUrl("https://www.reddit.com/u/d954mas/s/AbCdEf123")).toBeNull();
  });

  it("[12-06-s] redditBuildPermalink: slugged permalink from resolved parts (u_ → /user/, unsluggable title → 'post')", () => {
    expect(redditBuildPermalink("itchio", "1v93m2q", "My devlog: week 10!")).toBe(
      "https://www.reddit.com/r/itchio/comments/1v93m2q/my_devlog_week_10/",
    );
    // Profile pseudo-subreddit maps back to the /user/ root.
    expect(redditBuildPermalink("u_d954mas", "1sw3kot", null)).toBe(
      "https://www.reddit.com/user/d954mas/comments/1sw3kot/post/",
    );
    // The slug is NEVER empty — the detail endpoint degrades on slug-less URLs.
    expect(redditBuildPermalink("gamedev", "abc123", "…—!!")).toBe(
      "https://www.reddit.com/r/gamedev/comments/abc123/post/",
    );
  });
});

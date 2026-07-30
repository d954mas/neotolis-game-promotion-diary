// The feed card's Reddit source line. Pure unit test — no DB, no HTTP.
//
// The slug on a reddit_post event is Reddit's LITERAL subreddit id, and a PROFILE post
// lives in the pseudo-subreddit `u_<name>` (the value the API returns, the walker
// caches and the URL parser now derives from `/user/<name>/comments/<id>`). Rendering
// that verbatim produced "r/u_d954mas", which reads as a community that doesn't exist.
import { describe, expect, it } from "vitest";
import { redditSubredditLabel } from "$lib/components/feed/parts/derive-card-data.js";

describe("redditSubredditLabel", () => {
  it("renders a community slug as r/<sub>", () => {
    expect(redditSubredditLabel({ subreddit: "gamedev" })).toBe("r/gamedev");
  });

  it("[review-P1] renders the u_<name> profile pseudo-subreddit as u/<name>", () => {
    expect(redditSubredditLabel({ subreddit: "u_d954mas" })).toBe("u/d954mas");
  });

  it("renders nothing when the slug is absent, null or not a string", () => {
    expect(redditSubredditLabel({ subreddit: null })).toBe("");
    expect(redditSubredditLabel({})).toBe("");
    expect(redditSubredditLabel(null)).toBe("");
    expect(redditSubredditLabel({ subreddit: 42 })).toBe("");
  });
});

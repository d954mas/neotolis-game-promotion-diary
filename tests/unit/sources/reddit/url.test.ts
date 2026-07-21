// Wave-0 scaffold — flipped live by Plan 12-03 (redditParseSourceUrl +
// redditParsePostUrl). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit url parsing (Phase 12 rebuild)", () => {
  it.skip(
    "[12-03] redditParseSourceUrl: reddit.com/user/<u>, /u/<u>, old./m. hosts, raw u/<u> → reddit_account (lowercase)",
  );
  it.skip("[12-03] redditParseSourceUrl: /r/<sub> + raw r/<sub> → reddit_subreddit (lowercase)");
  it.skip("[12-03] redditParseSourceUrl: foreign host → null; rejects post URLs + bare names");
  it.skip(
    "[12-03] redditParsePostUrl: /r/<sub>/comments/<id>/<slug?> → reddit_post + subreddit metadata",
  );
  it.skip("[12-03] redditParsePostUrl: redd.it/<id> short-link → reddit_post, subreddit null");
  it.skip("[12-03] redditParsePostUrl: host-check FIRST — example.com/r/X/comments/Y → null");
});

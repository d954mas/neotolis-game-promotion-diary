// Wave-0 scaffold — flipped live by Plan 12-03 (normalize.ts, D-09 metric
// mapping + type derivation). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit normalize (D-09 mapping — Phase 12)", () => {
  it.skip("[12-03] normalize maps score→likes, num_comments→comments, views=null, shares=null");
  it.skip("[12-03] metrics-by-presence: both metrics absent → null (never 0)");
  it.skip(
    "[12-03] surfaces raw score/upvote_ratio/num_comments/num_crossposts/removed_by_category for the snapshot writer",
  );
  it.skip(
    "[12-03] type derivation (is_self/thumbnail ABSENT): post_hint / domain / url-vs-permalink / selftext / is_video → self|link|image|gallery",
  );
  it.skip("[12-03] thumbnail literals 'self'/'default'/'nsfw'/'spoiler' → null");
  it.skip("[12-03] buildRedditTitle: first text line, ~100 char cap");
  it.skip(
    "[12-03] union-by-presence: reads author-search (relative_position) AND subreddit (post_hint/domain/subreddit_id) shapes",
  );
});

// Wave-0 scaffold — flipped live by Plan 12-04 (snapshots.ts write path +
// deletion-detect). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit snapshots write path (Phase 12)", () => {
  it.skip(
    "[12-04] writeSnapshot UPSERTs reddit_posts + INSERTs reddit_post_snapshots with raw D-09 columns",
  );
  it.skip(
    "[12-04] upsertRedditAccount (by username) COALESCE-preserves richer fields on partial parse",
  );
  it.skip(
    "[12-04] upsertRedditSubreddit (by slug) COALESCE-preserves richer fields on partial parse",
  );
  it.skip(
    "[12-04] (post_id, polled_at) UNIQUE → within-the-minute retries idempotent (ON CONFLICT DO NOTHING)",
  );
  it.skip(
    "[12-04] deletion-detect: disappearance-from-walk / removed-or-not-found refresh sets deletion_detected_at idempotently",
  );
});

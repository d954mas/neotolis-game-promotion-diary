// Wave-0 scaffold — flipped live by Plan 12-05 (end-to-end backfill with a mock
// provider). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit e2e backfill (mock provider — Phase 12)", () => {
  it.skip(
    "[12-05] mock provider → backfill handler → reddit_posts + reddit_post_snapshots written",
  );
  it.skip("[12-05] backfill INSERTs the reddit_post events");
  it.skip("[12-05] writes the audit row (metadata.platform = reddit_account = QUOTA_PLATFORM)");
  it.skip("[12-05] per-user cap increments on user-initiated backfill");
});

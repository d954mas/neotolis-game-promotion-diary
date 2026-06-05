// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-03 / 08-05.
// Requirements: BACK-02, PLAT-01.
//
// The resumable IG account walker (mirror of YouTube handleBackfillChannel):
// one page/tick, cursor persisted to data_source_channel_state.metadata,
// backfill_complete on end-of-feed, resume on next tick. Integration test —
// real Postgres via ./helpers.js. The ScrapeCreators boundary is faked at the
// provider seam (vi.mock of the provider module), NEVER the DB.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js"); // provider seam, not the DB

describe("instagram account walker (resumable, cursor-persisted)", () => {
  it.skip("posts endpoint paginates via next_max_id and persists cursor to data_source_channel_state.metadata.lastBackfillCursor", async () => {
    // Plan 05: drive two pages off the mocked provider; assert the
    // persisted cursor equals the first page's next_max_id.
  });

  it.skip("reels endpoint paginates via paging_info.max_id (nested cursor)", async () => {
    // Plan 05: confirm the reels-vs-posts cursor divergence is absorbed —
    // the walker sees one uniform ProviderPage.nextCursor (08-SPIKE.md).
  });

  it.skip("sets backfill_complete on endOfFeed (more_available === false)", async () => {
    // Plan 05: last page sets data_source_channel_state.backfill_complete.
  });

  it.skip("resumes from the persisted cursor on the next tick", async () => {
    // Plan 05: a second tick passes the stored cursor back to the provider.
  });
});

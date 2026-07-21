// Wave-0 scaffold — flipped live by Plan 12-05. HIGH-RISK behavior (A): author
// completeness. Asserts against the 12-01 spike fixture
// tests/fixtures/reddit/author-search-page.json (the full 3-page, 17-post walk
// incl. the terminal null-`after` page). Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit author-walk completeness (Phase 12, spike-frozen)", () => {
  it.skip(
    "[12-05] paged author-search accumulates ALL posts across pages (fixture: 17 posts, 2020→2026)",
  );
  it.skip(
    "[12-05] terminates on the spike-confirmed end-of-feed signal: `after` absent/null (NOT empty posts[])",
  );
  it.skip(
    "[12-05] every accumulated post has author === the queried handle (author: filter honored, no popularity cap)",
  );
  it.skip(
    "[12-05] externalId = post.name (t3_...), created_utc monotonic non-increasing under sort=new",
  );
});

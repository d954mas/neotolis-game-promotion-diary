import { describe, it } from "vitest";

/**
 * Wave 0 placeholder test file (Plan 02-01 — Phase 2 Wave 0).
 *
 * Per Phase 1 Wave 0 invariant: every later task ships into a test that
 * already exists. The it.skip stubs below are EXACT names — implementing
 * plans (02-NN) replace `it.skip` with `it` and add the assertions.
 *
 * If you are an executor on a later plan and the test you need is NOT in
 * the it.skip list below, the gap is in this Wave 0 plan — fix it here,
 * NOT by silently adding a new it() in your plan's commit.
 */
describe("URL parser canonicalization", () => {
  it.skip("02-06: parseIngestUrl handles youtube.com/watch?v=ID", () => {
    /* placeholder — implementing plan: 02-06 */
  });
  it.skip("02-06: parseIngestUrl handles youtu.be/ID", () => {
    /* placeholder — implementing plan: 02-06 */
  });
  it.skip("02-06: parseIngestUrl handles /shorts/ID and /live/ID", () => {
    /* placeholder — implementing plan: 02-06 */
  });
  it.skip("02-06: parseIngestUrl canonicalizes x.com → twitter.com", () => {
    /* placeholder — implementing plan: 02-06 */
  });
  it.skip("02-06: parseIngestUrl returns reddit_deferred for reddit.com", () => {
    /* placeholder — implementing plan: 02-06 */
  });
});

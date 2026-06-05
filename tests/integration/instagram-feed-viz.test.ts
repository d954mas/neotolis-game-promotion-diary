// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-04 / 08-05.
// Requirements: VIZ-05.
//
// End-to-end feed/viz surface: an imported IG post lands in the /feed inbox
// (zero attached games), attaches to a game, then renders a metric series via
// fetchEventMetricSeries (the existing cross-source /games/[id] loop).
// Integration test — real Postgres via ./helpers.js; provider seam mocked.
import { describe, it } from "vitest";
// import { seedUserDirectly } from "./helpers.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("instagram feed inbox + metric series (VIZ-05)", () => {
  it.skip("an imported IG post lands in the /feed inbox with zero attached games", async () => {
    // Plan 04/05: pollContent imports an instagram_post event with source_id
    // set and no event_games rows (inbox criterion).
  });

  it.skip("attach to a game then the metric series renders via fetchEventMetricSeries", async () => {
    // Plan 04/05: after attach, getEventMetricSeries returns the IG snapshot
    // history (views/likes/comments) for /games/[id].
  });
});

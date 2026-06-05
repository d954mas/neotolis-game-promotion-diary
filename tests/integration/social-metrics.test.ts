// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-02.
// Requirements: OBS-01.
//
// Every provider request emits a Prometheus metric labeled by
// platform/provider/status (plus a credits counter), emitted inside the
// provider seam. Integration test — real Postgres via ./helpers.js; provider
// seam mocked (the metric emission is what we assert, via the prom-client
// register).
import { describe, it } from "vitest";
// import { register } from "$lib/server/metrics.js";
// vi.mock("$lib/sources/instagram/server/provider/scrapecreators.js");

describe("social provider OBS metrics (platform/provider/status labels)", () => {
  it.skip("a provider request emits neotolis_social_provider_requests_total with platform/provider/status labels", async () => {
    // Plan 02: after one mocked provider call, register.getSingleMetric(...)
    // shows a sample with labels { platform: "instagram", provider:
    // "scrapecreators", status: "200" }.
  });

  it.skip("the credits counter increments per request", async () => {
    // Plan 02: neotolis_social_provider_credits_total advances by creditsUsed
    // (1 per request, D-18).
  });
});

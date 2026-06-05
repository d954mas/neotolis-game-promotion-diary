// Social-provider OBS metrics — platform/provider/status labels (Plan 08-02).
// Requirements: OBS-01.
//
// Every request through the provider HTTP seam (instagram/server/http.ts
// instagramFetch) emits neotolis_social_provider_requests_total +
// _request_duration_seconds + _credits_total, labeled platform/provider/status.
// This test drives instagramFetch against a mocked global fetch and asserts the
// real prom-client `register` records the labeled samples. No DB I/O — the
// metric emission is the entire contract under test (it lives in the integration
// project because that's where the Wave-0 placeholder was seeded).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { register, socialProviderCredits } from "$lib/server/metrics.js";
import { instagramFetch } from "$lib/sources/instagram/server/http.js";

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("social provider OBS metrics (platform/provider/status labels)", () => {
  it("a provider request emits neotolis_social_provider_requests_total with platform/provider/status labels", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], more_available: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const url = new URL("https://api.scrapecreators.com/v2/instagram/user/posts?handle=nasa");
    const resp = await instagramFetch(url, {
      platform: "instagram",
      provider: "scrapecreators",
      logTag: "ig.posts",
    });
    expect(resp.status).toBe(200);

    const dump = await register.getSingleMetricAsString("neotolis_social_provider_requests_total");
    expect(dump).toContain('platform="instagram"');
    expect(dump).toContain('provider="scrapecreators"');
    expect(dump).toContain('status="200"');

    // The latency histogram carries the same label set.
    const durDump = await register.getSingleMetricAsString(
      "neotolis_social_provider_request_duration_seconds",
    );
    expect(durDump).toContain('platform="instagram"');
    expect(durDump).toContain('provider="scrapecreators"');
  });

  it("the credits counter increments per request", async () => {
    const labels = { platform: "instagram", provider: "scrapecreators" };
    const before = await readCounter("neotolis_social_provider_credits_total", labels);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], more_available: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await instagramFetch(
      new URL("https://api.scrapecreators.com/v2/instagram/user/posts?handle=nasa"),
      { platform: "instagram", provider: "scrapecreators", logTag: "ig.posts" },
    );

    const after = await readCounter("neotolis_social_provider_credits_total", labels);
    // 1 credit per successful request (D-18).
    expect(after - before).toBe(1);

    // Sanity: the collector is the registered singleton.
    expect(socialProviderCredits).toBeDefined();
  });

  it("a 402 (prepaid balance exhausted) still emits a 4xx-status request sample and does NOT charge a credit", async () => {
    const labels = { platform: "instagram", provider: "scrapecreators" };
    const creditsBefore = await readCounter("neotolis_social_provider_credits_total", labels);

    fetchSpy.mockResolvedValueOnce(new Response("", { status: 402 }));
    await expect(
      instagramFetch(
        new URL("https://api.scrapecreators.com/v2/instagram/user/posts?handle=nasa"),
        { platform: "instagram", provider: "scrapecreators", logTag: "ig.posts" },
      ),
    ).rejects.toMatchObject({ name: "AdapterError", category: "operator-issue" });

    const dump = await register.getSingleMetricAsString("neotolis_social_provider_requests_total");
    expect(dump).toContain('status="4xx"');
    // No credit charged on a non-200.
    const creditsAfter = await readCounter("neotolis_social_provider_credits_total", labels);
    expect(creditsAfter - creditsBefore).toBe(0);
  });
});

/** Read the current value of a labeled Counter sample from the live register. */
async function readCounter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const data = (await metric.get()) as {
    values: { value: number; labels: Record<string, string> }[];
  };
  const match = data.values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

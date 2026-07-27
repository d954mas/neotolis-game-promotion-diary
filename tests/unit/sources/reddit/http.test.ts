// redditFetch status -> AdapterError taxonomy.
//
// RESTORED COVERAGE: the pre-Phase-12 tree had tests/unit/sources/reddit/http.test.ts
// covering exactly this mapping; the rebuild deleted it and replaced it with nothing.
// The rebuilt http.ts has a RICHER taxonomy (401 / 402 / 404 / 429 + Retry-After /
// 5xx / 400 / last-resort / timeout) and not one branch was exercised anywhere —
// reddit-budget-key.test.ts drives the real redditFetch but its fetch stub hard-codes
// status 200. This is the code that runs on the operator's first expired key or
// rate-limit, i.e. the paths that only ever execute when something is already wrong.
//
// No DB: the quota seam is mocked so only the HTTP mapping is under test.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AdapterError } from "$lib/sources/errors.js";

const reserveSocialCredits = vi.fn();
const getSocialSpendToday = vi.fn();

// http.ts pulls the budget seam from the INSTAGRAM quota module (the shared
// ScrapeCreators pool lives there; reddit/server/quota.ts only re-exports it), so that
// is the module that has to be mocked — mocking the reddit re-export leaves the real
// DB-backed implementation in place.
vi.mock("../../../../src/lib/sources/instagram/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    reserveSocialCredits: (...args: unknown[]) => reserveSocialCredits(...args),
    getSocialSpendToday: (...args: unknown[]) => getSocialSpendToday(...args),
  };
});

const { redditFetch } = await import("../../../../src/lib/sources/reddit/server/http.js");

const URL_UNDER_TEST = new URL("https://api.scrapecreators.com/v1/reddit/search?query=author:x");
const CTX = { platform: "reddit", provider: "scrapecreators", logTag: "test" } as const;

/** Stub global fetch with one canned Response. */
function stubStatus(status: number, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(status === 200 ? "{}" : "", { status, headers })),
  );
}

/** Run redditFetch and return the AdapterError it threw (fails if it did not throw). */
async function captureError(): Promise<AdapterError> {
  let thrown: unknown = null;
  try {
    await redditFetch(URL_UNDER_TEST, { ...CTX, origin: "cron" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "redditFetch must throw for a non-2xx status").toBeInstanceOf(AdapterError);
  return thrown as AdapterError;
}

beforeEach(() => {
  reserveSocialCredits.mockReset();
  getSocialSpendToday.mockReset();
  // Default: budget available, so the reservation never short-circuits the HTTP path.
  reserveSocialCredits.mockResolvedValue({ creditsUsed: 1 });
  getSocialSpendToday.mockResolvedValue({ creditsUsed: 1, dailyCap: 1000, prepaidBalance: 500 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redditFetch — provider status taxonomy", () => {
  it("200 returns the raw Response for the caller to parse", async () => {
    stubStatus(200);
    const resp = await redditFetch(URL_UNDER_TEST, { ...CTX, origin: "cron" });
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
  });

  it("sends the x-api-key header (never Authorization)", async () => {
    stubStatus(200);
    await redditFetch(URL_UNDER_TEST, { ...CTX, origin: "cron" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call![1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers)).toEqual(["x-api-key"]);
  });

  it("401 (key invalid/revoked) -> operator-issue, NOT transient — retrying cannot fix it", async () => {
    stubStatus(401);
    expect((await captureError()).category).toBe("operator-issue");
  });

  it("402 (prepaid balance exhausted) -> operator-issue", async () => {
    stubStatus(402);
    expect((await captureError()).category).toBe("operator-issue");
  });

  it("404 (missing handle/subreddit) -> not-found", async () => {
    stubStatus(404);
    expect((await captureError()).category).toBe("not-found");
  });

  it("400 (request shape rejected — caller bug) -> permanent", async () => {
    stubStatus(400);
    expect((await captureError()).category).toBe("permanent");
  });

  it("500 and 503 -> transient", async () => {
    for (const status of [500, 503]) {
      stubStatus(status);
      expect((await captureError()).category, `status ${status}`).toBe("transient");
    }
  });

  it("an unmapped 4xx falls through to the transient last resort", async () => {
    stubStatus(418);
    expect((await captureError()).category).toBe("transient");
  });

  describe("429 Retry-After parsing", () => {
    it("integer seconds are converted to ms", async () => {
      stubStatus(429, { "retry-after": "12" });
      const err = await captureError();
      expect(err.category).toBe("rate-limited");
      expect(err.retryAfterMs).toBe(12_000);
    });

    it("an HTTP-date is converted to a positive delay", async () => {
      const when = new Date(Date.now() + 90_000).toUTCString();
      stubStatus(429, { "retry-after": when });
      const err = await captureError();
      expect(err.category).toBe("rate-limited");
      // toUTCString drops sub-second precision, so allow a small window.
      expect(err.retryAfterMs).toBeGreaterThan(80_000);
      expect(err.retryAfterMs).toBeLessThanOrEqual(90_000);
    });

    it("a past HTTP-date still yields a positive floor (never a negative delay)", async () => {
      stubStatus(429, { "retry-after": new Date(Date.now() - 60_000).toUTCString() });
      expect((await captureError()).retryAfterMs).toBe(1000);
    });

    it("a missing or garbage header falls back to 60s", async () => {
      stubStatus(429);
      expect((await captureError()).retryAfterMs).toBe(60_000);
      stubStatus(429, { "retry-after": "soon" });
      expect((await captureError()).retryAfterMs).toBe(60_000);
    });
  });

  describe("non-HTTP failures", () => {
    it("an abort (the 30s timeout) -> transient", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new DOMException("aborted", "AbortError");
        }),
      );
      expect((await captureError()).category).toBe("transient");
    });

    it("a network error -> transient", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      expect((await captureError()).category).toBe("transient");
    });
  });

  describe("reserve-before-HTTP refusal (no request is ever issued)", () => {
    it("a denied reservation with a DEPLETED prepaid balance -> operator-issue", async () => {
      reserveSocialCredits.mockResolvedValue(null);
      getSocialSpendToday.mockResolvedValue({ creditsUsed: 0, dailyCap: 1000, prepaidBalance: 0 });
      stubStatus(200);
      const err = await captureError();
      expect(err.category).toBe("operator-issue");
      expect(globalThis.fetch, "no paid request may be issued after a refusal").not.toBeCalled();
    });

    it("a denied reservation with budget remaining -> rate-limited (daily cap, resets at midnight PT)", async () => {
      reserveSocialCredits.mockResolvedValue(null);
      getSocialSpendToday.mockResolvedValue({
        creditsUsed: 950,
        dailyCap: 1000,
        prepaidBalance: 500,
      });
      stubStatus(200);
      const err = await captureError();
      expect(err.category).toBe("rate-limited");
      expect(globalThis.fetch).not.toBeCalled();
    });
  });
});

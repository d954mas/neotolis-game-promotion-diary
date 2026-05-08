// Phase 03.0.1 Plan 08 — chargedFetch reservoir + AdapterError taxonomy unit tests.
//
// Pin the contract surface of the upgraded HTTP wrapper:
//   - Reservoir consume (cron pool 8000 / user pool 2000) per origin.
//   - AdapterError taxonomy: 403 quotaExceeded → rate-limited;
//     403 other → operator-issue; 404 → not-found; 5xx → transient.
//
// Mocks fetch (global) and ./quota.js (incrementUsage / markThrottleTransition)
// so the test does NOT touch Postgres. The reservoir state is reset between
// tests via __resetReservoirsForTest().

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdapterError } from "$lib/sources/errors.js";

// Mock the quota module so chargedFetch's incrementUsage + markThrottleTransition
// calls don't try to hit Postgres. Each test resets the mock counters.
vi.mock("$lib/sources/youtube/server/quota.js", async () => {
  const actual = await vi.importActual<typeof import("$lib/sources/youtube/server/quota.js")>(
    "$lib/sources/youtube/server/quota.js",
  );
  return {
    ...actual,
    incrementUsage: vi.fn(async () => {}),
    markThrottleTransition: vi.fn(async () => {}),
  };
});

const PICKED = { apiKey: "test-key", apiKeyId: "key-abc" };

beforeEach(async () => {
  // Reset both reservoirs to full so tests are independent.
  const { __resetReservoirsForTest } = await import("$lib/sources/youtube/server/http.js");
  await __resetReservoirsForTest();
  vi.restoreAllMocks();
});

describe("chargedFetch — reservoir consume + AdapterError taxonomy (Plan 08)", () => {
  it("returns Response on 2xx (no throw, no error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ kind: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    const resp = await chargedFetch(url, PICKED, 1, {
      origin: "user",
      logTag: "test",
    });
    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
  });

  it("403 with errors[].reason='quotaExceeded' → AdapterError(rate-limited) with retryAfterMs > 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    await expect(chargedFetch(url, PICKED, 1, { origin: "cron", logTag: "test" })).rejects.toThrow(
      AdapterError,
    );
    try {
      await chargedFetch(url, PICKED, 1, { origin: "cron", logTag: "test" });
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).not.toBeNull();
      expect(ae.retryAfterMs!).toBeGreaterThan(0);
    }
  });

  it("403 with non-quotaExceeded reason → AdapterError(operator-issue)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    try {
      await chargedFetch(url, PICKED, 1, { origin: "cron", logTag: "test" });
      expect.fail("expected AdapterError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).category).toBe("operator-issue");
    }
  });

  it("404 → AdapterError(not-found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    try {
      await chargedFetch(url, PICKED, 1, { origin: "user", logTag: "test" });
      expect.fail("expected AdapterError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).category).toBe("not-found");
    }
  });

  it("5xx → AdapterError(transient)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    try {
      await chargedFetch(url, PICKED, 1, { origin: "cron", logTag: "test" });
      expect.fail("expected AdapterError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).category).toBe("transient");
    }
  });

  it("user reservoir exhaustion → AdapterError(rate-limited) before fetch fires", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    // user pool = 2000 points. Drain all of it in one call.
    await chargedFetch(url, PICKED, 2000, { origin: "user", logTag: "drain" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Next call must throw rate-limited WITHOUT firing fetch.
    try {
      await chargedFetch(url, PICKED, 1, { origin: "user", logTag: "second" });
      expect.fail("expected AdapterError(rate-limited)");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs!).toBeGreaterThan(0);
    }
    // Crucially: the second call did NOT touch fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cron reservoir is independent from user reservoir", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    // Drain user pool entirely.
    await chargedFetch(url, PICKED, 2000, { origin: "user", logTag: "drain-user" });
    // cron pool (8000) should still allow a 100-unit call.
    const resp = await chargedFetch(url, PICKED, 100, {
      origin: "cron",
      logTag: "cron-after-user-drained",
    });
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

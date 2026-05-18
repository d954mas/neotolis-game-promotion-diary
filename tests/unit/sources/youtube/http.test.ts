// chargedFetch DB-reservation + AdapterError taxonomy unit tests.
//
// Mocks fetch (global) and ./quota.js so the test does not touch Postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdapterError } from "$lib/sources/errors.js";

vi.mock("$lib/sources/youtube/server/quota.js", async () => {
  const actual = await vi.importActual<typeof import("$lib/sources/youtube/server/quota.js")>(
    "$lib/sources/youtube/server/quota.js",
  );
  return {
    ...actual,
    hasYoutubeApiKeys: vi.fn(() => true),
    reserveYoutubeQuota: vi.fn(async (args: { origin: "cron" | "user"; units: number }) => ({
      apiKey: "test-key",
      apiKeyId: "key-abc",
      poolKind: args.origin,
      units: args.units,
    })),
    markThrottleTransition: vi.fn(async () => {}),
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  const quota = await import("$lib/sources/youtube/server/quota.js");
  vi.mocked(quota.hasYoutubeApiKeys).mockReturnValue(true);
  vi.mocked(quota.reserveYoutubeQuota).mockImplementation(
    async (args: { origin: "cron" | "user"; units: number }) => ({
      apiKey: "test-key",
      apiKeyId: "key-abc",
      poolKind: args.origin,
      units: args.units,
    }),
  );
});

describe("chargedFetch - DB reservation + AdapterError taxonomy", () => {
  it("returns Response on 2xx", async () => {
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
    const resp = await chargedFetch(url, 1, { origin: "user", logTag: "test" });
    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
    expect(url.searchParams.get("key")).toBe("test-key");
  });

  it("403 quotaExceeded -> AdapterError(rate-limited)", async () => {
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
    await expect(chargedFetch(url, 1, { origin: "cron", logTag: "test" })).rejects.toThrow(
      AdapterError,
    );
    try {
      await chargedFetch(url, 1, { origin: "cron", logTag: "test" });
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).not.toBeNull();
      expect(ae.retryAfterMs!).toBeGreaterThan(0);
    }
  });

  it("403 non-quotaExceeded -> AdapterError(operator-issue)", async () => {
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
    await expect(chargedFetch(url, 1, { origin: "cron", logTag: "test" })).rejects.toMatchObject({
      category: "operator-issue",
    });
  });

  it("404 -> AdapterError(not-found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    await expect(chargedFetch(url, 1, { origin: "user", logTag: "test" })).rejects.toMatchObject({
      category: "not-found",
    });
  });

  it("5xx -> AdapterError(transient)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");
    await expect(chargedFetch(url, 1, { origin: "cron", logTag: "test" })).rejects.toMatchObject({
      category: "transient",
    });
  });

  it("reservation exhaustion -> AdapterError(rate-limited) before fetch fires", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const quota = await import("$lib/sources/youtube/server/quota.js");
    vi.mocked(quota.reserveYoutubeQuota).mockResolvedValueOnce(null);
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");

    await expect(chargedFetch(url, 1, { origin: "user", logTag: "test" })).rejects.toMatchObject({
      category: "rate-limited",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes origin through to the DB reservation", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const quota = await import("$lib/sources/youtube/server/quota.js");
    const { chargedFetch } = await import("$lib/sources/youtube/server/http.js");
    const url = new URL("https://example.com/foo");

    await chargedFetch(url, 2000, { origin: "user", logTag: "drain-user" });
    const resp = await chargedFetch(url, 100, {
      origin: "cron",
      logTag: "cron-after-user-drained",
    });

    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(quota.reserveYoutubeQuota).toHaveBeenNthCalledWith(1, { origin: "user", units: 2000 });
    expect(quota.reserveYoutubeQuota).toHaveBeenNthCalledWith(2, { origin: "cron", units: 100 });
  });
});

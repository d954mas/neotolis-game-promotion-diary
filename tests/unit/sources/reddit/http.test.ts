// Reddit redditFetch unit tests (Phase 03.1 DV-RDT-7).
//
// Pin the contract surface of the HTTP wrapper under DV-RDT-7:
//   - Every fetch carries `User-Agent: env.REDDIT_USER_AGENT` (V4).
//   - AdapterError 5-category taxonomy mapping for 200/403/404/429/5xx/network/Zod.
//   - 403-burst (3 × 403 in 5 min window) emits exactly ONE
//     `reddit.adapter_degraded` audit row per burst (V5, D-RDT-AUTH-403).
//   - Retry-After / X-Ratelimit-Reset parsing for retryAfterMs (V16).
//   - Reddit not configured → operator-issue (safety-net).
//
// Mocks: global fetch + `$lib/server/audit.js` writeAudit + env module.
// No Postgres I/O — pure unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdapterError } from "$lib/sources/errors.js";

const REDDIT_UA = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";

const writeAuditSpy = vi.fn(async () => {});
const fetchSpy = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  fetchSpy.mockReset();
  writeAuditSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.doMock("$lib/server/config/env.js", () => ({
    env: { REDDIT_USER_AGENT: REDDIT_UA },
  }));
  vi.doMock("$lib/server/audit.js", () => ({ writeAudit: writeAuditSpy }));
});

afterEach(() => {
  vi.doUnmock("$lib/server/config/env.js");
  vi.doUnmock("$lib/server/audit.js");
  vi.restoreAllMocks();
});

describe("redditFetch (Phase 03.1 DV-RDT-7) — AdapterError taxonomy", () => {
  it("200 OK returns parsed JSON + User-Agent header was sent (V4)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ x: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    const r = await redditFetch<{ x: number }>("/r/test/new.json?limit=100");
    expect(r.data).toEqual({ x: 1 });
    expect(r.statusCode).toBe(200);
    // User-Agent capture.
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[0]).toBe("https://www.reddit.com/r/test/new.json?limit=100");
    const reqHeaders = callArgs[1].headers as Record<string, string>;
    expect(reqHeaders["User-Agent"]).toBe(REDDIT_UA);
  });

  it("404 → AdapterError(not-found)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/comments/abc.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("not-found");
      expect(ae.context.httpStatus).toBe(404);
    }
  });

  it("429 with Retry-After: 30 → AdapterError(rate-limited, retryAfterMs=30000) (V16)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).toBe(30_000);
    }
  });

  it("429 with X-Ratelimit-Reset fallback → AdapterError(rate-limited, retryAfterMs=45000)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "x-ratelimit-reset": "45" } }),
    );
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).toBe(45_000);
    }
  });

  it("500 → AdapterError(transient, httpStatus=500)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 500 }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("transient");
      expect(ae.context.httpStatus).toBe(500);
    }
  });

  it("network error (ECONNRESET) → AdapterError(transient)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("transient");
    }
  });

  it("single 403 → AdapterError(rate-limited, httpStatus=403); no audit yet (under burst threshold)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("rate-limited");
      expect(ae.context.httpStatus).toBe(403);
    }
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("3 × 403 within 5min window emits exactly ONE reddit.adapter_degraded audit row (V5, D-RDT-AUTH-403)", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy.mock.calls[0][0]).toMatchObject({
      action: "reddit.adapter_degraded",
    });
    const meta = writeAuditSpy.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.burst_count).toBe(3);
    expect(meta.window_minutes).toBe(5);

    // Subsequent 403s within the same burst window do NOT re-emit.
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
  });

  it("after burst window expires (5min elapsed), counter resets — next 403 starts new burst", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();

    // Trigger 3 × 403 → audit emitted.
    const nowSpy = vi.spyOn(Date, "now");
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);

    // Advance time past the 5-min window (window_ms = 300_000).
    nowSpy.mockReturnValue(T0 + 6 * 60_000);

    // 1 × 403 — new window started; counter=1, audit NOT re-emitted yet.
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);

    // 2 more → 3 in new window → 2nd audit.
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    await expect(redditFetch("/r/x/new.json")).rejects.toBeInstanceOf(AdapterError);
    expect(writeAuditSpy).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("Zod parse failure on response body → AdapterError(permanent)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    const { z } = await import("zod");
    const schema = z.object({ expected: z.string() });
    try {
      await redditFetch("/r/x/new.json", { schema });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("permanent");
      expect(ae.cause).toBeDefined();
    }
  });

  it("Reddit not configured (REDDIT_USER_AGENT empty) → AdapterError(operator-issue)", async () => {
    vi.resetModules();
    vi.doMock("$lib/server/config/env.js", () => ({ env: { REDDIT_USER_AGENT: "" } }));
    vi.doMock("$lib/server/audit.js", () => ({ writeAudit: writeAuditSpy }));
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      const ae = err as AdapterError;
      expect(ae.category).toBe("operator-issue");
      expect(ae.message).toContain("reddit_not_configured");
    }
    // Importantly: no fetch was attempted.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schema-passing response returns parsed data (happy path)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "Listing", data: { children: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { redditFetch, __resetBurstStateForTest } = await import(
      "$lib/sources/reddit/server/http.js"
    );
    __resetBurstStateForTest();
    const { z } = await import("zod");
    const schema = z.object({ kind: z.literal("Listing"), data: z.object({ children: z.array(z.unknown()) }) });
    const r = await redditFetch("/r/x/new.json", { schema });
    expect(r.data).toEqual({ kind: "Listing", data: { children: [] } });
  });
});

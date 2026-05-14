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
//
// Module-instance note: `vi.resetModules()` invalidates the module registry
// between tests. A statically imported `AdapterError` is a DIFFERENT class
// instance than the one http.ts throws (the dynamic import gets a fresh
// module evaluation). We assert on `.name === "AdapterError"` + duck-type
// `.category` rather than `instanceof` to stay robust across instances.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const REDDIT_UA = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";

// Stub the env module shape used transitively by http.ts:
//   - REDDIT_USER_AGENT (credentials.ts)
//   - LOG_LEVEL + NODE_ENV (logger.ts via pino constructor)
//   - ADMIN_EMAIL_ALLOWLIST (resolveOperatorUserId)
function envMock(
  overrides: Partial<{
    REDDIT_USER_AGENT: string;
    ADMIN_EMAIL_ALLOWLIST: readonly string[];
  }> = {},
): { env: Record<string, unknown> } {
  return {
    env: {
      REDDIT_USER_AGENT: REDDIT_UA,
      ADMIN_EMAIL_ALLOWLIST: [] as readonly string[],
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
      ...overrides,
    },
  };
}

/** Type-narrow err to an AdapterError-shaped object across module instances. */
interface AdapterErrorLike {
  name: string;
  message: string;
  category: string;
  retryAfterMs: number | null;
  context: Record<string, unknown>;
  cause?: unknown;
}

function asAdapterError(err: unknown): AdapterErrorLike {
  expect(err).toBeInstanceOf(Error);
  const e = err as Record<string, unknown>;
  expect(e.name).toBe("AdapterError");
  return err as unknown as AdapterErrorLike;
}

/** writeAudit signature: `(entry: AuditEntry) => Promise<void>`. The spy
 *  type carries the same argument so .mock.calls[N][0] narrows to the
 *  entry shape (not the `never` you get from a parameterless vi.fn). */
const writeAuditSpy = vi.fn(
  async (_entry: {
    userId: string;
    action: string;
    ipAddress: string;
    metadata?: Record<string, unknown>;
  }) => {},
);
const fetchSpy = vi.fn();

/** Mock the drizzle db `select().from().where().limit()` chain to return
 *  the operator's user_id for `resolveOperatorUserId`. The burst-audit
 *  code path needs a real user_id (audit_log.user_id is NOT NULL). */
function mockOperatorDb(operatorId: string | null): void {
  const limitFn = vi.fn().mockResolvedValue(operatorId === null ? [] : [{ id: operatorId }]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  vi.doMock("$lib/server/db/client.js", () => ({ db: { select: selectFn } }));
  vi.doMock("$lib/server/db/schema/auth.js", () => ({
    user: { id: "user.id", email: "user.email" },
  }));
}

beforeEach(() => {
  vi.resetModules();
  fetchSpy.mockReset();
  writeAuditSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.doMock("$lib/server/config/env.js", () =>
    envMock({ ADMIN_EMAIL_ALLOWLIST: ["op@example.com"] }),
  );
  vi.doMock("$lib/server/audit.js", () => ({ writeAudit: writeAuditSpy }));
  mockOperatorDb("op-user-123");
});

afterEach(() => {
  vi.doUnmock("$lib/server/config/env.js");
  vi.doUnmock("$lib/server/audit.js");
  vi.doUnmock("$lib/server/db/client.js");
  vi.doUnmock("$lib/server/db/schema/auth.js");
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
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    const r = await redditFetch<{ x: number }>("/r/test/new.json?limit=100");
    expect(r.data).toEqual({ x: 1 });
    expect(r.statusCode).toBe(200);
    // User-Agent capture.
    const callArgs = fetchSpy.mock.calls[0]!;
    expect(callArgs[0]).toBe("https://www.reddit.com/r/test/new.json?limit=100");
    const reqHeaders = callArgs[1].headers as Record<string, string>;
    expect(reqHeaders["User-Agent"]).toBe(REDDIT_UA);
  });

  it("404 → AdapterError(not-found)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 404 }));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/comments/abc.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("not-found");
      expect(ae.context.httpStatus).toBe(404);
    }
  });

  it("429 with Retry-After: 30 → AdapterError(rate-limited, retryAfterMs=30000) (V16)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).toBe(30_000);
    }
  });

  it("429 with X-Ratelimit-Reset fallback → AdapterError(rate-limited, retryAfterMs=45000)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "x-ratelimit-reset": "45" } }),
    );
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("rate-limited");
      expect(ae.retryAfterMs).toBe(45_000);
    }
  });

  it("500 → AdapterError(transient, httpStatus=500)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 500 }));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("transient");
      expect(ae.context.httpStatus).toBe(500);
    }
  });

  it("network error (ECONNRESET) → AdapterError(transient)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("transient");
    }
  });

  it("single 403 → AdapterError(rate-limited, httpStatus=403); no audit yet (under burst threshold)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("rate-limited");
      expect(ae.context.httpStatus).toBe(403);
    }
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("3 × 403 within 5min window emits exactly ONE reddit.adapter_degraded audit row (V5, D-RDT-AUTH-403)", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const firstCall = writeAuditSpy.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({ action: "reddit.adapter_degraded" });
    const meta = firstCall!.metadata!;
    expect(meta.burst_count).toBe(3);
    expect(meta.window_minutes).toBe(5);

    // Subsequent 403s within the same burst window do NOT re-emit.
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
  });

  it("after burst window expires (5min elapsed), counter resets — next 403 starts new burst", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 403 }));
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();

    // Trigger 3 × 403 → audit emitted.
    const nowSpy = vi.spyOn(Date, "now");
    const T0 = 1_000_000_000_000;
    nowSpy.mockReturnValue(T0);
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);

    // Advance time past the 5-min window (window_ms = 300_000).
    nowSpy.mockReturnValue(T0 + 6 * 60_000);

    // 1 × 403 — new window started; counter=1, audit NOT re-emitted yet.
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);

    // 2 more → 3 in new window → 2nd audit.
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
    await redditFetch("/r/x/new.json").catch((e) => asAdapterError(e));
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
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    const { z } = await import("zod");
    const schema = z.object({ expected: z.string() });
    try {
      await redditFetch("/r/x/new.json", { schema });
      throw new Error("should have thrown");
    } catch (err) {
      const ae = asAdapterError(err);
      expect(ae.category).toBe("permanent");
      expect(ae.cause).toBeDefined();
    }
  });

  it("Reddit not configured (REDDIT_USER_AGENT empty) → AdapterError(operator-issue)", async () => {
    // Use vi.doUnmock + vi.doMock (instead of vi.resetModules + vi.doMock)
    // to override the beforeEach env mock without invalidating the
    // already-registered audit + db mocks. resetModules invalidates
    // module cache but doMock REGISTRATIONS persist — however, the
    // dynamic import of http.js below transitively imports credentials.js
    // and errors.js, and any race in registration order surfaces as
    // "TypeError vs AdapterError" on the runner. Re-asserting all mocks
    // immediately before the import keeps the load order deterministic.
    vi.doUnmock("$lib/server/config/env.js");
    vi.resetModules();
    vi.doMock("$lib/server/config/env.js", () =>
      envMock({ REDDIT_USER_AGENT: "", ADMIN_EMAIL_ALLOWLIST: ["op@example.com"] }),
    );
    vi.doMock("$lib/server/audit.js", () => ({ writeAudit: writeAuditSpy }));
    mockOperatorDb("op-user-123");
    const httpMod = await import("$lib/sources/reddit/server/http.js");
    const { redditFetch, __resetBurstStateForTest } = httpMod;
    __resetBurstStateForTest();
    try {
      await redditFetch("/r/x/new.json");
      throw new Error("should have thrown");
    } catch (err) {
      // If the env mock didn't land, this throws TypeError before reaching
      // AdapterError. Surface a useful diagnostic instead of the bare name
      // mismatch.
      if (err instanceof Error && err.name === "TypeError") {
        throw new Error(
          `Expected AdapterError but got TypeError: ${err.message}. ` +
            `This usually means the env.js mock did not apply before http.ts loaded — ` +
            `check vi.doMock ordering / module-cache state.`,
        );
      }
      const ae = asAdapterError(err);
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
    const { redditFetch, __resetBurstStateForTest } =
      await import("$lib/sources/reddit/server/http.js");
    __resetBurstStateForTest();
    const { z } = await import("zod");
    const schema = z.object({
      kind: z.literal("Listing"),
      data: z.object({ children: z.array(z.unknown()) }),
    });
    const r = await redditFetch("/r/x/new.json", { schema });
    expect(r.data).toEqual({ kind: "Listing", data: { children: [] } });
  });
});

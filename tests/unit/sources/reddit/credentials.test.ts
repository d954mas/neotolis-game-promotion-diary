import { describe, it, expect, vi, afterEach } from "vitest";

// Reddit credentials.ts unit tests (Phase 03.1 DV-RDT-7).
//
// pickRedditCredentials + isRedditConfigured are thin wrappers over
// env.REDDIT_USER_AGENT. The contract under test:
//   - empty UA   ⇒ pickRedditCredentials() === null, isRedditConfigured() === false
//   - configured ⇒ pickRedditCredentials() returns { userAgent }, isRedditConfigured() === true
//   - no I/O    ⇒ purely synchronous, no DB, no fetch
//
// Pattern: vi.doMock the env module before each dynamic import so the
// module-under-test reads the stubbed value. resetModules between cases
// guarantees the import re-runs with the fresh mock. Mirrors the pattern
// in tests/unit/sources/youtube/http.test.ts.

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("$lib/server/config/env.js");
  vi.restoreAllMocks();
});

describe("Reddit credentials.ts (Phase 03.1 DV-RDT-7)", () => {
  it("returns null when REDDIT_USER_AGENT is empty", async () => {
    vi.resetModules();
    vi.doMock("$lib/server/config/env.js", () => ({ env: { REDDIT_USER_AGENT: "" } }));
    const { pickRedditCredentials, isRedditConfigured } =
      await import("$lib/sources/reddit/server/credentials.js");
    expect(pickRedditCredentials()).toBeNull();
    expect(isRedditConfigured()).toBe(false);
  });

  it("returns { userAgent } when REDDIT_USER_AGENT is configured", async () => {
    vi.resetModules();
    const ua = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";
    vi.doMock("$lib/server/config/env.js", () => ({ env: { REDDIT_USER_AGENT: ua } }));
    const { pickRedditCredentials, isRedditConfigured } =
      await import("$lib/sources/reddit/server/credentials.js");
    expect(pickRedditCredentials()).toEqual({ userAgent: ua });
    expect(isRedditConfigured()).toBe(true);
  });

  it("pickRedditCredentials does not perform I/O (no fetch, no DB call)", async () => {
    vi.resetModules();
    const ua = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";
    vi.doMock("$lib/server/config/env.js", () => ({ env: { REDDIT_USER_AGENT: ua } }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { pickRedditCredentials } = await import("$lib/sources/reddit/server/credentials.js");
    pickRedditCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a fresh object on each call (no shared mutable state)", async () => {
    vi.resetModules();
    const ua = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";
    vi.doMock("$lib/server/config/env.js", () => ({ env: { REDDIT_USER_AGENT: ua } }));
    const { pickRedditCredentials } = await import("$lib/sources/reddit/server/credentials.js");
    const a = pickRedditCredentials();
    const b = pickRedditCredentials();
    expect(a).toEqual(b);
    // Different references — caller can mutate without affecting others.
    expect(a).not.toBe(b);
  });
});

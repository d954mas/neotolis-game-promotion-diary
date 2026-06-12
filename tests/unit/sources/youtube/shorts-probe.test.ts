// YouTube Shorts redirect probe — THE decider (user-locked 2026-06-12). Mocks
// global.fetch to pin the redirect → verdict mapping:
//   200                          → "short"
//   3xx → /watch                 → "video"
//   3xx → consent.* → retry SOCS → re-classify (or null if still ambiguous)
//   anything else / network fail → null (unknown; leave media_type NULL)
//
// The probe issues a plain unauthenticated GET against the public web frontend
// (no Data API, no quota), so these tests assert behavior purely via the
// fetch response shape.

import { describe, it, expect, afterEach, vi } from "vitest";
import { probeIsShort } from "../../../../src/lib/sources/youtube/server/shorts-probe.js";

interface MockResp {
  status: number;
  location?: string | null;
}

interface Capture {
  url: string;
  headers: Record<string, string>;
}

/** Queue a sequence of responses; capture each call's URL + headers. */
function installFetchMock(responses: MockResp[]): Capture[] {
  const calls: Capture[] = [];
  let i = 0;
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({ url: String(input), headers });
    const next = responses[i++];
    if (!next) throw new Error(`fetch called more than queued (${i})`);
    return new Response(null, {
      status: next.status,
      headers: next.location != null ? { location: next.location } : {},
    });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeIsShort — verdict mapping", () => {
  it("200 OK → 'short' (YouTube served the Shorts player)", async () => {
    const calls = installFetchMock([{ status: 200 }]);
    expect(await probeIsShort("vid200")).toBe("short");
    // It probed the /shorts/<id> URL with a desktop UA.
    expect(calls[0]!.url).toBe("https://www.youtube.com/shorts/vid200");
    expect(calls[0]!.headers["User-Agent"]).toMatch(/Mozilla/);
  });

  it("303 → /watch?v=… → 'video' (bounced to the standard watch page)", async () => {
    installFetchMock([{ status: 303, location: "https://www.youtube.com/watch?v=vidW" }]);
    expect(await probeIsShort("vidW")).toBe("video");
  });

  it("302 → relative /watch Location → 'video'", async () => {
    installFetchMock([{ status: 302, location: "/watch?v=vidRel" }]);
    expect(await probeIsShort("vidRel")).toBe("video");
  });

  it("consent.google.com → retry with SOCS cookie → 200 → 'short'", async () => {
    const calls = installFetchMock([
      { status: 302, location: "https://consent.google.com/m?continue=..." },
      { status: 200 },
    ]);
    expect(await probeIsShort("vidConsent")).toBe("short");
    // Exactly ONE retry, and it carried the consent-accepted cookie.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Cookie"]).toBe("SOCS=CAI");
  });

  it("consent.youtube.com → retry → /watch → 'video'", async () => {
    installFetchMock([
      { status: 302, location: "https://consent.youtube.com/m?continue=..." },
      { status: 301, location: "https://www.youtube.com/watch?v=vidC2" },
    ]);
    expect(await probeIsShort("vidC2")).toBe("video");
  });

  it("consent → retry STILL consent → null (ambiguous, never guess)", async () => {
    installFetchMock([
      { status: 302, location: "https://consent.google.com/m" },
      { status: 302, location: "https://consent.google.com/m" },
    ]);
    expect(await probeIsShort("vidStuck")).toBeNull();
  });

  it("3xx to an UNEXPECTED host (not /watch, not consent) → null", async () => {
    installFetchMock([{ status: 302, location: "https://www.youtube.com/feed/subscriptions" }]);
    expect(await probeIsShort("vidWeird")).toBeNull();
  });

  it("404 → null (unknown; leave media_type NULL)", async () => {
    installFetchMock([{ status: 404 }]);
    expect(await probeIsShort("vid404")).toBeNull();
  });

  it("500 → null", async () => {
    installFetchMock([{ status: 500 }]);
    expect(await probeIsShort("vid500")).toBeNull();
  });

  it("3xx with NO Location header → null", async () => {
    installFetchMock([{ status: 302, location: null }]);
    expect(await probeIsShort("vidNoLoc")).toBeNull();
  });

  it("network failure → null (probe failures are non-fatal)", async () => {
    const stub = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", stub);
    expect(await probeIsShort("vidNet")).toBeNull();
  });
});

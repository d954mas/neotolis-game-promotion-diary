// TikTok short-link resolution — vm.tiktok.com / vt.tiktok.com canonicalization
// (D-06). Unit test for the resolver's host gate + redirect-hop + error mapping.
// `fetch` is mocked so no live HTTP happens.
//
// Requirements: PLAT-02 (D-06).
import { describe, it, expect, vi, afterEach } from "vitest";
import { AdapterError } from "$lib/sources/errors.js";
import { resolveTikTokShortLink } from "$lib/sources/tiktok/server/short-link.js";

/** Stub a fetch that returns a manual-redirect Response carrying `location`. */
function redirectTo(location: string | null): Response {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tiktok short-link resolver (D-06)", () => {
  it("[10-03] a vm.tiktok.com short link resolves to the canonical /@handle/video/<id> URL", async () => {
    const canonical = "https://www.tiktok.com/@stoolpresidente/video/7649569886871522573";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectTo(canonical));
    expect(await resolveTikTokShortLink("https://vm.tiktok.com/ZGef/")).toBe(canonical);
  });

  it("[10-03] a vt.tiktok.com short link resolves to the canonical video URL", async () => {
    const canonical = "https://www.tiktok.com/@zachking/video/123";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectTo(canonical));
    expect(await resolveTikTokShortLink("https://vt.tiktok.com/AbCd/")).toBe(canonical);
  });

  it("[10-03] a non-short host passes through unchanged (nothing to resolve)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = "https://www.tiktok.com/@h/video/9";
    expect(await resolveTikTokShortLink(input)).toBe(input);
    // No network hop for a non-short host.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("[10-03] a redirect that lands off TikTok returns null (open-redirect guard)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(redirectTo("https://evil.example/phish"));
    expect(await resolveTikTokShortLink("https://vm.tiktok.com/ZGef/")).toBeNull();
  });

  it("[10-03] a resolve timeout surfaces as an AdapterError(transient), not a crash", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const caught = await resolveTikTokShortLink("https://vm.tiktok.com/ZGef/").catch((e) => e);
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).category).toBe("transient");
  });
});

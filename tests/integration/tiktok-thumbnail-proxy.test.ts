import { describe, it, expect } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import { tiktokPosts } from "../../src/lib/server/db/schema/index.js";
import { resolveTikTokThumbnailUrl } from "../../src/lib/sources/tiktok/server/thumbnail-proxy.js";

// The same-origin thumbnail proxy (10-SPIKE.md Q3 RESOLVED at Plan 05 UAT — the
// TikTok CDN cover hotlinks BLOCKED in a real browser, net::ERR_BLOCKED_BY_ORB,
// while a server-side fetch of the same URL returns 200) must only ever fetch
// URLs we stored ourselves, host-validated against the TikTok CDN.
// resolveTikTokThumbnailUrl is the SSRF guard: it reads tiktok_posts.thumbnail_url
// by aweme_id and refuses anything that isn't a known CDN host. The route never
// takes a URL from the request, so this lookup is the whole attack surface
// (mirrors the IG proxy guard, #69).

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("tiktok thumbnail proxy — resolveTikTokThumbnailUrl (Q3 RESOLVED)", () => {
  it("returns the stored URL for a valid tiktokcdn-us.com host", async () => {
    const awemeId = `tk-proxy-ok-${uniq()}`;
    const url = "https://p16-sign-va.tiktokcdn-us.com/obj/x.awebp?x-expires=1&x-signature=abc";
    await db.insert(tiktokPosts).values({ awemeId, thumbnailUrl: url });
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBe(url);
  });

  it("accepts the base tiktokcdn.com CDN host too", async () => {
    const awemeId = `tk-proxy-base-${uniq()}`;
    const url = "https://p16.tiktokcdn.com/obj/x.awebp";
    await db.insert(tiktokPosts).values({ awemeId, thumbnailUrl: url });
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBe(url);
  });

  it("returns null (SSRF guard) for a non-TikTok host", async () => {
    const awemeId = `tk-proxy-evil-${uniq()}`;
    await db
      .insert(tiktokPosts)
      .values({ awemeId, thumbnailUrl: "https://evil.example.com/x.awebp" });
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBeNull();
  });

  it("rejects a look-alike host (suffix guard, not substring)", async () => {
    const awemeId = `tk-proxy-lookalike-${uniq()}`;
    // `tiktokcdn.com.evil.com` must NOT pass the `.tiktokcdn.com` suffix check —
    // the leading dot is what prevents the substring-spoof.
    await db
      .insert(tiktokPosts)
      .values({ awemeId, thumbnailUrl: "https://tiktokcdn.com.evil.com/x.awebp" });
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBeNull();
  });

  it("returns null for an unknown post and for a thumbnail-less row", async () => {
    expect(await resolveTikTokThumbnailUrl(`tk-missing-${uniq()}`)).toBeNull();
    const awemeId = `tk-proxy-nothumb-${uniq()}`;
    await db.insert(tiktokPosts).values({ awemeId, thumbnailUrl: null });
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBeNull();
  });
});

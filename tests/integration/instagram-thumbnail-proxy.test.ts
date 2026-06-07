import { describe, it, expect } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import { instagramPosts } from "../../src/lib/server/db/schema/index.js";
import { resolveInstagramThumbnailUrl } from "../../src/lib/sources/instagram/server/thumbnail-proxy.js";

// The same-origin thumbnail proxy (#69) must only ever fetch URLs we stored
// ourselves, host-validated against the Instagram/Facebook CDN. resolve*Url is
// the SSRF guard: it reads instagram_posts.thumbnail_url by post_id and refuses
// anything that isn't a known CDN host. The route never takes a URL from the
// request, so this lookup is the whole attack surface.

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("instagram thumbnail proxy — resolveInstagramThumbnailUrl (#69)", () => {
  it("returns the stored URL for a valid Instagram CDN host", async () => {
    const postId = `proxy-ok-${uniq()}`;
    const url = "https://scontent-ord5-3.cdninstagram.com/v/t51.82787-15/x.jpg?oe=6A2AB2C0";
    await db.insert(instagramPosts).values({ postId, thumbnailUrl: url });
    expect(await resolveInstagramThumbnailUrl(postId)).toBe(url);
  });

  it("accepts the fbcdn.net CDN host too", async () => {
    const postId = `proxy-fb-${uniq()}`;
    const url = "https://scontent.fbcdn.net/v/x.jpg";
    await db.insert(instagramPosts).values({ postId, thumbnailUrl: url });
    expect(await resolveInstagramThumbnailUrl(postId)).toBe(url);
  });

  it("returns null (SSRF guard) for a non-Instagram host", async () => {
    const postId = `proxy-evil-${uniq()}`;
    await db
      .insert(instagramPosts)
      .values({ postId, thumbnailUrl: "https://evil.example.com/x.jpg" });
    expect(await resolveInstagramThumbnailUrl(postId)).toBeNull();
  });

  it("rejects a look-alike host (suffix guard, not substring)", async () => {
    const postId = `proxy-lookalike-${uniq()}`;
    // `cdninstagram.com.evil.com` must NOT pass the `.cdninstagram.com` suffix
    // check — the leading dot is what prevents the substring-spoof.
    await db
      .insert(instagramPosts)
      .values({ postId, thumbnailUrl: "https://cdninstagram.com.evil.com/x.jpg" });
    expect(await resolveInstagramThumbnailUrl(postId)).toBeNull();
  });

  it("returns null for an unknown post and for a thumbnail-less row", async () => {
    expect(await resolveInstagramThumbnailUrl(`missing-${uniq()}`)).toBeNull();
    const postId = `proxy-nothumb-${uniq()}`;
    await db.insert(instagramPosts).values({ postId, thumbnailUrl: null });
    expect(await resolveInstagramThumbnailUrl(postId)).toBeNull();
  });
});

// TikTok cover byte-cache (fixes the prod 502 on /api/tiktok/thumbnail).
//
// The proxy used to re-fetch tiktok_posts.thumbnail_url — a tiktokcdn signed URL
// (x-expires) that expires in hours while the account poll is daily, so most
// cover loads 502'd. The fix caches the cover BYTES at poll time (writeSnapshot,
// while the URL is fresh) and serves them from the proxy expiry-proof.
//
// Real Postgres; the only mock is the cover fetch (fetchCoverBytes) — we never
// hit the live TikTok CDN. Proves: a fresh URL caches bytes+content-type; an
// unchanged URL on re-poll does NOT re-fetch; a fetch miss leaves bytes null +
// keeps the URL; the proxy serves cached bytes WITHOUT an upstream fetch and
// falls back to the URL-fetch when bytes are absent; the host guard still rejects
// a non-tiktokcdn URL.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// Scripted cover-fetch result + a call counter so we can assert "did NOT re-fetch".
let scriptedCover: { bytes: Buffer; contentType: string } | null = null;
const fetchCoverBytesMock = vi.fn(async (_url: string) => scriptedCover);
vi.mock("../../src/lib/sources/tiktok/server/thumbnail-proxy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchCoverBytes: fetchCoverBytesMock };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { tiktokPosts } = await import("../../src/lib/server/db/schema/index.js");
const { writeSnapshot } = await import("../../src/lib/sources/tiktok/server/snapshots.js");
const { resolveTikTokThumbnailUrl } =
  await import("../../src/lib/sources/tiktok/server/thumbnail-proxy.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const cdnUrl = (v: string): string =>
  `https://p16-sign-va.tiktokcdn-us.com/obj/${v}.awebp?x-expires=1&x-signature=abc`;

async function readPost(awemeId: string) {
  const [row] = await db
    .select()
    .from(tiktokPosts)
    .where(eq(tiktokPosts.awemeId, awemeId))
    .limit(1);
  return row;
}

const okMetrics = { views: 10, likes: 2, comments: 1, shares: 3 };

beforeEach(() => {
  scriptedCover = null;
  fetchCoverBytesMock.mockClear();
});

describe("tiktok cover byte-cache (writeSnapshot)", () => {
  it("caches bytes + content_type when a fresh thumbnail_url is written", async () => {
    const awemeId = `tk-cache-fresh-${uniq()}`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    scriptedCover = { bytes, contentType: "image/webp" };

    await writeSnapshot({
      awemeId,
      thumbnailUrl: cdnUrl("a"),
      status: "ok",
      metrics: okMetrics,
    });

    expect(fetchCoverBytesMock).toHaveBeenCalledTimes(1);
    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toEqual(bytes);
    expect(row!.thumbnailContentType).toBe("image/webp");
    expect(row!.thumbnailUrl).toBe(cdnUrl("a"));
  });

  it("does NOT re-fetch when an unchanged thumbnail_url is re-polled", async () => {
    const awemeId = `tk-cache-unchanged-${uniq()}`;
    scriptedCover = { bytes: Buffer.from([1, 2, 3]), contentType: "image/webp" };
    await writeSnapshot({
      awemeId,
      thumbnailUrl: cdnUrl("same"),
      status: "ok",
      metrics: okMetrics,
    });
    expect(fetchCoverBytesMock).toHaveBeenCalledTimes(1);

    // Re-poll with the SAME URL (cache already populated) → no second fetch.
    fetchCoverBytesMock.mockClear();
    await writeSnapshot({
      awemeId,
      thumbnailUrl: cdnUrl("same"),
      status: "ok",
      metrics: okMetrics,
    });
    expect(fetchCoverBytesMock).not.toHaveBeenCalled();
    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toEqual(Buffer.from([1, 2, 3]));
  });

  it("re-fetches when the thumbnail_url changes (new signed URL)", async () => {
    const awemeId = `tk-cache-changed-${uniq()}`;
    scriptedCover = { bytes: Buffer.from([1]), contentType: "image/webp" };
    await writeSnapshot({ awemeId, thumbnailUrl: cdnUrl("v1"), status: "ok", metrics: okMetrics });

    fetchCoverBytesMock.mockClear();
    scriptedCover = { bytes: Buffer.from([2, 2]), contentType: "image/jpeg" };
    await writeSnapshot({ awemeId, thumbnailUrl: cdnUrl("v2"), status: "ok", metrics: okMetrics });

    expect(fetchCoverBytesMock).toHaveBeenCalledTimes(1);
    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toEqual(Buffer.from([2, 2]));
    expect(row!.thumbnailContentType).toBe("image/jpeg");
  });

  it("leaves bytes null + keeps the URL when the cover fetch fails", async () => {
    const awemeId = `tk-cache-miss-${uniq()}`;
    scriptedCover = null; // fetch miss (non-ok / network / non-image)

    await writeSnapshot({
      awemeId,
      thumbnailUrl: cdnUrl("miss"),
      status: "ok",
      metrics: okMetrics,
    });

    expect(fetchCoverBytesMock).toHaveBeenCalledTimes(1);
    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toBeNull();
    expect(row!.thumbnailContentType).toBeNull();
    // Graceful: the URL is still stored, so the proxy URL-fallback applies.
    expect(row!.thumbnailUrl).toBe(cdnUrl("miss"));
  });

  it("preserves a working cached cover on a later fetch miss (COALESCE, not blank)", async () => {
    const awemeId = `tk-cache-preserve-${uniq()}`;
    scriptedCover = { bytes: Buffer.from([9, 9, 9]), contentType: "image/webp" };
    await writeSnapshot({
      awemeId,
      thumbnailUrl: cdnUrl("good"),
      status: "ok",
      metrics: okMetrics,
    });

    // New URL, but the cover fetch now misses → must NOT blank the prior cache.
    scriptedCover = null;
    await writeSnapshot({ awemeId, thumbnailUrl: cdnUrl("new"), status: "ok", metrics: okMetrics });

    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toEqual(Buffer.from([9, 9, 9]));
    expect(row!.thumbnailContentType).toBe("image/webp");
  });

  it("does not fetch when the incoming thumbnail_url is null", async () => {
    const awemeId = `tk-cache-nullurl-${uniq()}`;
    await writeSnapshot({ awemeId, thumbnailUrl: null, status: "ok", metrics: okMetrics });
    expect(fetchCoverBytesMock).not.toHaveBeenCalled();
    const row = await readPost(awemeId);
    expect(row!.thumbnailBytes).toBeNull();
  });
});

// The proxy route: cached bytes win (no upstream fetch); fall back to the URL
// fetch when bytes are absent. We mount the route on a Hono app and stub global
// fetch so we can assert whether the upstream CDN was contacted.
const { Hono } = await import("hono");
const { tiktokThumbnailRoutes } =
  await import("../../src/lib/sources/tiktok/server/thumbnail-proxy.js");

function buildApp() {
  const app = new Hono();
  app.route("/api", tiktokThumbnailRoutes);
  return app;
}

describe("tiktok thumbnail proxy — serves cached bytes", () => {
  it("serves cached bytes WITHOUT an upstream fetch when bytes are present", async () => {
    const awemeId = `tk-proxy-cached-${uniq()}`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20]);
    await db.insert(tiktokPosts).values({
      awemeId,
      thumbnailUrl: cdnUrl("c"),
      thumbnailBytes: bytes,
      thumbnailContentType: "image/jpeg",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await buildApp().request(`/api/tiktok/thumbnail/${awemeId}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    // The whole point: expiry-proof, no upstream CDN contact.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("falls back to the URL fetch when cached bytes are absent (legacy row)", async () => {
    const awemeId = `tk-proxy-legacy-${uniq()}`;
    await db
      .insert(tiktokPosts)
      .values({ awemeId, thumbnailUrl: cdnUrl("legacy"), thumbnailBytes: null });

    const upstreamBytes = new Uint8Array([0x01, 0x02, 0x03]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(upstreamBytes, { status: 200, headers: { "content-type": "image/webp" } }),
      );
    const res = await buildApp().request(`/api/tiktok/thumbnail/${awemeId}`);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(cdnUrl("legacy"));
    fetchSpy.mockRestore();
  });

  it("404s an unknown post (no bytes, no URL)", async () => {
    const res = await buildApp().request(`/api/tiktok/thumbnail/tk-proxy-unknown-${uniq()}`);
    expect(res.status).toBe(404);
  });

  it("host guard still rejects a non-tiktokcdn URL on the fallback path", async () => {
    const awemeId = `tk-proxy-evil-${uniq()}`;
    await db
      .insert(tiktokPosts)
      .values({ awemeId, thumbnailUrl: "https://evil.example.com/x.awebp", thumbnailBytes: null });
    // No cached bytes → resolveTikTokThumbnailUrl rejects the host → 404, never fetched.
    expect(await resolveTikTokThumbnailUrl(awemeId)).toBeNull();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await buildApp().request(`/api/tiktok/thumbnail/${awemeId}`);
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

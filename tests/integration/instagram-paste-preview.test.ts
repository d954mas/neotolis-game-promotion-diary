// IG live paste-preview — synchronous single-post fetch for Add Event (issue #65).
//
// Pasting an instagram.com/p|reel link in the Add Event flow now RECOGNIZES the
// kind + URL AND auto-fills title (caption first line) + description + thumbnail
// via a synchronous by-URL provider fetch, mirroring the Reddit pattern:
//   - enrichFromUrl(instagram_post) dispatches to
//     instagramAdapter.fetchEventPreviewMetadata, which issues ONE by-URL
//     provider request (1 credit), cap-gated against the per-user 50/day social
//     cap, then UPSERTs the instagram_posts cache + a snapshot so the saved
//     event renders fully in /feed.
//   - A reel URL → media_type "short"; a /p/ image → "image"; sidecar →
//     "carousel" (the single-post API has no product_type, so the permalink IS
//     the short-vs-video discriminator).
//   - A failed preview (cap-exhausted, provider error, deleted post) degrades to
//     recognition-only so the user can still save a bare manual event.
//
// Integration test — real Postgres via ./helpers.js; the provider seam is mocked
// at provider/registry's getSocialProvider (NEVER the DB). NEVER mocks the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

// A controllable single-post fetcher: the test pushes the next response (or a
// throw) before driving enrichFromUrl. `calls` records the URL + origin so the
// metering wiring (origin="user") is assertable.
interface ScriptedSinglePost {
  next: NormalizedSinglePost | null | (() => never);
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, calls: [] };

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          if (typeof single.next === "function") single.next();
          return single.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async resolveAccount() {
          return { accountId: "acct-preview", displayName: "Preview" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { instagramPosts, instagramPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { enrichFromUrl } = await import("../../src/lib/server/services/events-mutation.js");
const { env } = await import("../../src/lib/server/config/env.js");

const PLATFORM = "instagram_account";

function singlePost(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "media-1",
    shortcode: "ABC123",
    kind: "image",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: null, likes: 42, comments: 7 },
    caption: "First line caption\nSecond line ignored",
    thumbnailUrl: "https://cdn.instagram.com/media-1.jpg",
    ownerId: "owner-99",
    ownerUsername: "neonicle_dev",
    ...overrides,
  };
}

beforeEach(() => {
  single.next = null;
  single.calls = [];
});

describe("instagram live paste-preview (single-post fetch, issue #65)", () => {
  it("a pasted /p/ post URL auto-fills title (caption first line) + description + thumbnail + kind", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-ok-${Math.random().toString(36).slice(2)}@t.io`,
    });
    single.next = singlePost({ id: "p-ok", shortcode: "PCODE1" });

    const result = await enrichFromUrl(user.id, "https://www.instagram.com/p/PCODE1/", "127.0.0.1");

    expect(result.kind).toBe("instagram_post");
    // Title = caption FIRST line (D-09), not the whole multi-line caption.
    expect(result.title).toBe("First line caption");
    expect(result.thumbnailUrl).toBe("https://cdn.instagram.com/media-1.jpg");
    expect(result.authorName).toBe("neonicle_dev");
    expect(result.authorUrl).toBe("https://www.instagram.com/neonicle_dev/");
    expect(result.occurredAt?.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    // externalId is the URL-intrinsic shortcode (parseIngestUrl), canonical URL preserved.
    expect(result.externalId).toBe("PCODE1");
    expect(result.canonicalUrl).toBe("https://www.instagram.com/p/PCODE1/");

    // The provider was called with the canonical permalink + the user-pool origin
    // (cost guardrail: the by-URL fetch reserves against the user budget).
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe("https://www.instagram.com/p/PCODE1/");
    expect(single.calls[0]!.origin).toBe("user");
  });

  it("UPSERTs the instagram_posts cache row + a snapshot so the saved event renders fully in /feed", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-cache-${Math.random().toString(36).slice(2)}@t.io`,
    });
    single.next = singlePost({
      id: "p-cache",
      shortcode: "CACHE1",
      kind: "image",
      metrics: { views: null, likes: 11, comments: 3 },
    });

    await enrichFromUrl(user.id, "https://www.instagram.com/p/CACHE1/", "127.0.0.1");

    const [cached] = await db
      .select()
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, "p-cache"));
    expect(cached).toBeDefined();
    expect(cached!.accountId).toBe("owner-99");
    expect(cached!.mediaType).toBe("image");
    expect(cached!.thumbnailUrl).toBe("https://cdn.instagram.com/media-1.jpg");
    expect(cached!.permalink).toBe("https://www.instagram.com/p/CACHE1/");
    expect(cached!.lastPollStatus).toBe("ok");

    const snaps = await db
      .select()
      .from(instagramPostSnapshots)
      .where(eq(instagramPostSnapshots.postId, "p-cache"));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.likeCount).toBe(11);
    expect(snaps[0]!.commentCount).toBe(3);
    expect(snaps[0]!.viewCount).toBeNull(); // photo → no views (D-05)
  });

  it("a /reel/ URL maps media_type to 'short'", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-reel-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // The provider's normalizer resolves the kind; the fake mirrors that by
    // returning kind="short" for a reel permalink. (The normalizer's own
    // reel-vs-/p/ rule is asserted in the unit test.)
    single.next = singlePost({ id: "r-short", shortcode: "REEL1", kind: "short" });

    await enrichFromUrl(user.id, "https://www.instagram.com/reel/REEL1/", "127.0.0.1");

    const [cached] = await db
      .select()
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, "r-short"));
    expect(cached!.mediaType).toBe("short");
  });

  it("a /p/ image maps to 'image' and a sidecar maps to 'carousel'", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-types-${Math.random().toString(36).slice(2)}@t.io`,
    });

    single.next = singlePost({ id: "img-1", shortcode: "IMG1", kind: "image" });
    await enrichFromUrl(user.id, "https://www.instagram.com/p/IMG1/", "127.0.0.1");
    const [img] = await db.select().from(instagramPosts).where(eq(instagramPosts.postId, "img-1"));
    expect(img!.mediaType).toBe("image");

    single.next = singlePost({ id: "car-1", shortcode: "CAR1", kind: "carousel" });
    await enrichFromUrl(user.id, "https://www.instagram.com/p/CAR1/", "127.0.0.1");
    const [car] = await db.select().from(instagramPosts).where(eq(instagramPosts.postId, "car-1"));
    expect(car!.mediaType).toBe("carousel");
  });

  it("consults the per-user cap (writes the cap-counter audit row that getUserQuotaUsedToday SUMs)", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-cap-${Math.random().toString(36).slice(2)}@t.io`,
    });

    const before = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(before.requests).toBe(0);

    single.next = singlePost({ id: "cap-1", shortcode: "CAP1" });
    await enrichFromUrl(user.id, "https://www.instagram.com/p/CAP1/", "127.0.0.1");

    // A successful preview wrote exactly ONE cap-counter audit row
    // (event.poll_refreshed / flow=stats_refresh / platform=instagram_account /
    // requests_used=1) so the per-user cap advances by one.
    const after = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(after.requests).toBe(1);

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, user.id));
    const capRows = rows.filter(
      (r) =>
        r.action === "event.poll_refreshed" &&
        (r.metadata as { flow?: string }).flow === "stats_refresh" &&
        (r.metadata as { platform?: string }).platform === PLATFORM,
    );
    expect(capRows).toHaveLength(1);
  });

  it("a cap-exhausted user degrades gracefully to recognition-only (no crash, no credit burned)", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-exhausted-${Math.random().toString(36).slice(2)}@t.io`,
    });

    // Park the user AT the per-user cap so the gate fires BEFORE the fetch.
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    for (let i = 0; i < cap; i++) {
      await writeAuditStrict({
        userId: user.id,
        action: "source.refresh_content_requested",
        ipAddress: "0.0.0.0",
        metadata: {
          kind: PLATFORM,
          platform: PLATFORM,
          flow: "incremental",
          requests_used: 1,
          events_inserted: 0,
        },
      });
    }
    single.next = singlePost({ id: "should-not-fetch", shortcode: "NOPE1" });

    // No throw — the form must still let the user save a bare event.
    const result = await enrichFromUrl(user.id, "https://www.instagram.com/p/NOPE1/", "127.0.0.1");

    // Recognition-only shape: kind + shortcode + canonical permalink, EMPTY title.
    expect(result.kind).toBe("instagram_post");
    expect(result.title).toBe("");
    expect(result.externalId).toBe("NOPE1");
    expect(result.canonicalUrl).toBe("https://www.instagram.com/p/NOPE1/");
    expect(result.thumbnailUrl).toBeNull();

    // The gate fired BEFORE the provider call — no credit burned.
    expect(single.calls).toHaveLength(0);
    // No cache row written.
    const cached = await db
      .select()
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, "should-not-fetch"));
    expect(cached).toHaveLength(0);
  });

  it("a provider error degrades gracefully to recognition-only (manual entry preserved)", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-err-${Math.random().toString(36).slice(2)}@t.io`,
    });
    single.next = () => {
      throw new Error("provider exploded");
    };

    const result = await enrichFromUrl(user.id, "https://www.instagram.com/p/BOOM1/", "127.0.0.1");

    expect(result.kind).toBe("instagram_post");
    expect(result.title).toBe("");
    expect(result.externalId).toBe("BOOM1");
  });

  it("a deleted/private post (null body) degrades to recognition-only", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-null-${Math.random().toString(36).slice(2)}@t.io`,
    });
    single.next = null; // provider returns null → no media object

    const result = await enrichFromUrl(user.id, "https://www.instagram.com/p/GONE1/", "127.0.0.1");

    expect(result.kind).toBe("instagram_post");
    expect(result.title).toBe("");
    // The provider WAS called (the cap was consulted) but no cache row landed.
    expect(single.calls).toHaveLength(1);
    const cached = await db.select().from(instagramPosts);
    expect(cached.find((p) => p.permalink?.includes("GONE1"))).toBeUndefined();
  });

  it("a caption-less post falls back to the 'Instagram <mediaType> · <date>' title (form requires non-empty)", async () => {
    const user = await seedUserDirectly({
      email: `ig-preview-nocap-${Math.random().toString(36).slice(2)}@t.io`,
    });
    single.next = singlePost({
      id: "nocap-1",
      shortcode: "NOCAP1",
      kind: "short",
      caption: null,
      publishedAt: new Date("2026-05-15T00:00:00Z"),
    });

    const result = await enrichFromUrl(
      user.id,
      "https://www.instagram.com/reel/NOCAP1/",
      "127.0.0.1",
    );

    expect(result.title).toBe("Instagram short · 2026-05-15");
  });
});

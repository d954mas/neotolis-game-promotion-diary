// Twitter/X paste preview — pasting a tweet URL issues ONE by-URL provider request
// (1 credit, gated by the per-user + operator budget), UPSERTs the twitter_posts
// cache + a snapshot (incl the DERIVED shares), and re-derives the externalId (tweet
// id) from OUR cache on create (untrusted body, #70). NO t.co short-link resolve
// (D-07 — X URLs are already full x.com URLs).
//
// Tests the ADAPTER seam directly (fetchEventPreviewMetadata + resolveCachedExternalId).
// The provider seam is mocked at provider/registry's getSocialProvider; NEVER the DB.
//
// Requirements: PLAT-03 (#70 cached-externalId re-derivation).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, calls: [] };
let providerConfigured = true;

vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTwitterConfigured: () => providerConfigured,
    getSocialProvider: (platform: string) => {
      if (platform !== "twitter" || !providerConfigured) return null;
      return {
        name: "twitterapi.io",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          return single.next;
        },
        async resolveAccount() {
          return { accountId: "acct-preview-tw", displayName: "Preview" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { twitterPosts, twitterPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { twitterAdapter: adapter } = await import("../../src/lib/sources/twitter/server/index.js");
const { enrichFromUrl } = await import("../../src/lib/server/services/events-mutation.js");

// USER-QUOTA keyspace = the source kind (mirrors TikTok's "tiktok_account"), NOT the
// social-budget label "twitter".
const PLATFORM = "twitter_account";

if (adapter.fetchEventPreviewMetadata === undefined) throw new Error("preview missing");
if (adapter.resolveCachedExternalId === undefined) throw new Error("resolveCached missing");
const fetchEventPreviewMetadata = adapter.fetchEventPreviewMetadata;
const resolveCachedExternalId = adapter.resolveCachedExternalId;

function singlePost(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "1799999999999999999",
    shortcode: "1799999999999999999",
    kind: "video",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    // shares = retweet + quote (DERIVED, D-05).
    metrics: { views: 100000, likes: 5000, comments: 200, shares: 42 },
    caption: "First line caption\nSecond line ignored",
    thumbnailUrl: "https://pbs.twimg.com/cover.jpg",
    ownerId: "115216851",
    ownerUsername: "supergiantgames",
    ...overrides,
  };
}

beforeEach(() => {
  single.next = null;
  single.calls = [];
  providerConfigured = true;
});

describe("twitter paste preview (single-tweet fetch, adapter seam)", () => {
  it("[11-03] a single-tweet fetch caches the tweet row + writes a snapshot", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-ok-${Math.random()}@t.io` });
    single.next = singlePost();

    const result = await fetchEventPreviewMetadata(
      "https://x.com/supergiantgames/status/1799999999999999999",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.title).toBe("First line caption");
    expect(result.thumbnailUrl).toBe("https://pbs.twimg.com/cover.jpg");
    expect(result.authorName).toBe("supergiantgames");
    expect(result.authorUrl).toBe("https://x.com/supergiantgames");
    expect(result.externalId).toBe("1799999999999999999");

    // The provider was called with the user-pool origin (cost guardrail).
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.origin).toBe("user");

    // The cache row + a snapshot landed.
    const [cached] = await db
      .select()
      .from(twitterPosts)
      .where(eq(twitterPosts.tweetId, "1799999999999999999"));
    expect(cached).toBeDefined();
    expect(cached!.accountId).toBe("115216851");
    expect(cached!.mediaType).toBe("video");
    expect(cached!.lastPollStatus).toBe("ok");
  });

  it("[11-03] the snapshot carries the DERIVED share_count (the paste path)", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-shares-${Math.random()}@t.io` });
    single.next = singlePost({ id: "1700000000000000001", shortcode: "1700000000000000001" });

    await fetchEventPreviewMetadata("https://x.com/h/status/1700000000000000001", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    const [snap] = await db
      .select()
      .from(twitterPostSnapshots)
      .where(eq(twitterPostSnapshots.tweetId, "1700000000000000001"));
    expect(snap!.shareCount).toBe(42);
    expect(snap!.viewCount).toBe(100000);
  });

  it("[11-03] the preview reserves exactly one credit against the shared budget (cap counter advances)", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-cap-${Math.random()}@t.io` });
    const before = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(before.requests).toBe(0);

    single.next = singlePost({ id: "1700000000000000002", shortcode: "1700000000000000002" });
    await fetchEventPreviewMetadata("https://x.com/h/status/1700000000000000002", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

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

  it("[11-03] the cached externalId is re-derived from OUR cache row, not the request body (#70)", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-cache-${Math.random()}@t.io` });
    const canonical = "https://x.com/supergiantgames/status/1799999999999999999";
    single.next = singlePost();
    await fetchEventPreviewMetadata(canonical, { userId: user.id, ipAddress: "127.0.0.1" });

    // Same canonical URL → the cached tweet id (re-derived from the permalink row).
    const derived = await resolveCachedExternalId(canonical);
    expect(derived).toBe("1799999999999999999");

    // A URL with no cache row → the URL-INTRINSIC tweet id (the id IS the /status/<id>
    // slug, so on a no-preview miss the URL itself is the authoritative key).
    const miss = await resolveCachedExternalId("https://x.com/nobody/status/1230000000000000000");
    expect(miss).toBe("1230000000000000000");

    // A non-Twitter / unparseable URL → null (no id derivable).
    expect(await resolveCachedExternalId("https://example.com/not-a-tweet")).toBeNull();
  });

  it("[11-03] a query-tailed paste (?s=20) still hits the create-time cache lookup (canonical permalink stored)", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-tail-${Math.random()}@t.io` });
    const tailed = "https://x.com/supergiantgames/status/1700000000000000003?s=20&t=abc";
    single.next = singlePost({ id: "1700000000000000003", shortcode: "1700000000000000003" });
    await fetchEventPreviewMetadata(tailed, { userId: user.id, ipAddress: "127.0.0.1" });

    // The cache row's permalink is the canonical (no-query) URL.
    const [cached] = await db
      .select()
      .from(twitterPosts)
      .where(eq(twitterPosts.tweetId, "1700000000000000003"));
    expect(cached!.permalink).toBe("https://x.com/supergiantgames/status/1700000000000000003");

    // The create-time lookup hits whether the saved URL carries the query tail or not.
    expect(await resolveCachedExternalId(tailed)).toBe("1700000000000000003");
    expect(
      await resolveCachedExternalId("https://x.com/supergiantgames/status/1700000000000000003"),
    ).toBe("1700000000000000003");
  });

  it("[11-03] a deleted/private tweet (null body) degrades to unavailable (no cache row)", async () => {
    const user = await seedUserDirectly({ email: `tw-preview-null-${Math.random()}@t.io` });
    single.next = null; // provider returns null → no tweet object

    const result = await fetchEventPreviewMetadata("https://x.com/h/status/1700000000000000004", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    expect(result.kind).toBe("unavailable");
    expect(single.calls).toHaveLength(1);
    const cached = await db
      .select()
      .from(twitterPosts)
      .where(eq(twitterPosts.tweetId, "1700000000000000004"));
    expect(cached).toHaveLength(0);
  });
});

// Cross-source enrichFromUrl wiring (the activation seam Plan 04 owed — mirrors the
// TikTok 10-05 "FIX 2" seam): a pasted x.com/status URL routes parseIngestUrl →
// enrichFromUrl(twitter_post) → twitterAdapter.fetchEventPreviewMetadata, NOT the
// old hardcoded kind_not_yet_functional stub. This block is the gate that would have
// caught that stub — the adapter-seam tests above call the hook directly and so
// could not. The provider seam is mocked at provider/registry; the DB is real.
describe("twitter enrichFromUrl wiring (the cross-source paste seam)", () => {
  it("[11-04] a pasted tweet URL returns an enriched twitter_post preview (not kind_not_yet_functional)", async () => {
    const user = await seedUserDirectly({ email: `tw-enrich-ok-${Math.random()}@t.io` });
    single.next = singlePost({ id: "1710000000000000001", shortcode: "1710000000000000001" });

    const result = await enrichFromUrl(
      user.id,
      "https://x.com/supergiantgames/status/1710000000000000001",
      "127.0.0.1",
    );

    expect(result.kind).toBe("twitter_post");
    // The tweet id, threaded from preview.externalId = post.id — NOT a URL guess.
    expect(result.externalId).toBe("1710000000000000001");
    expect(result.title).toBeTruthy();
    expect(result.thumbnailUrl).toBe("https://pbs.twimg.com/cover.jpg");
    // The parser canonicalizes x.com → twitter.com (the canonical host).
    expect(result.canonicalUrl).toBe(
      "https://twitter.com/supergiantgames/status/1710000000000000001",
    );
    // Metered against the user pool (cost guardrail).
    expect(single.calls[0]!.origin).toBe("user");
  });

  it("[11-04] a query-tailed paste (?s=20) canonicalizes before the fetch (D-07 strip)", async () => {
    const user = await seedUserDirectly({ email: `tw-enrich-tail-${Math.random()}@t.io` });
    single.next = singlePost({ id: "1710000000000000002", shortcode: "1710000000000000002" });

    const result = await enrichFromUrl(
      user.id,
      "https://x.com/supergiantgames/status/1710000000000000002?s=20&t=abc",
      "127.0.0.1",
    );

    expect(result.kind).toBe("twitter_post");
    // The stored URL is the clean canonical permalink (x.com → twitter.com, tail stripped).
    expect(result.canonicalUrl).toBe(
      "https://twitter.com/supergiantgames/status/1710000000000000002",
    );
  });

  it("[11-04] recognition-only degrade when the provider is unconfigured (SOC-05)", async () => {
    providerConfigured = false;
    const user = await seedUserDirectly({ email: `tw-enrich-noprov-${Math.random()}@t.io` });

    const result = await enrichFromUrl(
      user.id,
      "https://x.com/h/status/1710000000000000003",
      "127.0.0.1",
    );

    // SOC-05: manual entry never dead-ends — kind + canonical URL are recognized but
    // title is empty + externalId null (no live fetch resolved a tweet id; never the
    // URL slug, which would strand the event on a pending badge).
    expect(result.kind).toBe("twitter_post");
    expect(result.title).toBe("");
    expect(result.externalId).toBeNull();
    expect(result.canonicalUrl).toBe("https://twitter.com/h/status/1710000000000000003");
    // No provider call (unconfigured) → no cache row.
    expect(single.calls).toHaveLength(0);
  });
});

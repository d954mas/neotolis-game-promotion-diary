// Reddit paste preview — pasting a Reddit post URL issues ONE by-URL provider
// request (1 credit, gated by the per-user + operator budget), UPSERTs the
// reddit_posts cache + a snapshot, and re-derives the externalId (t3 fullname) from
// the URL-intrinsic slug on create (untrusted body).
//
// This is the "provider-ON" money path every sibling paid adapter tests
// (instagram/tiktok/twitter/telegram-paste-preview) — Phase 12 shipped only the
// provider-OFF slice, so the reddit CAP-ENFORCEMENT wiring (does the preview call
// enforceAdapterUserQuota with QUOTA_PLATFORM = the source kind?) and the
// paste→snapshot pipeline were unverified. Tests the ADAPTER seam directly
// (fetchEventPreviewMetadata + resolveCachedExternalId). The provider seam is mocked
// at provider/registry's getSocialProvider; the DB is real. NEVER mocks the DB.
//
// Requirements: PLAT-04 / D-01 (shared ScrapeCreators budget).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, calls: [] };
// When false, getSocialProvider returns null (provider unconfigured) exactly as the
// self-host default (REDDIT_IMPORT_ENABLED unset) does.
let providerConfigured = true;

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => providerConfigured,
    getSocialProvider: (platform: string) => {
      if (platform !== "reddit" || !providerConfigured) return null;
      return {
        name: "scrapecreators-reddit",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          return single.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null };
        },
        async resolveAccount() {
          return { accountId: "acct-preview-rdt", displayName: "Preview" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { redditPosts, redditPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { redditAdapter: adapter } = await import("../../src/lib/sources/reddit/server/index.js");

// USER-QUOTA keyspace = the source kind (mirrors IG/TikTok), NOT the social-budget
// label "reddit". getUserQuotaUsedToday / the QuotaStatusBanner read by adapter.kind,
// so the cap-counter audit rows MUST carry this value.
const PLATFORM = "reddit_account";

// The SourceAdapter contract types these as optional (`?:`); the barrel spreads them
// in, so they are present at runtime. Bind the non-optional functions once.
if (adapter.fetchEventPreviewMetadata === undefined) throw new Error("preview missing");
if (adapter.resolveCachedExternalId === undefined) throw new Error("resolveCached missing");
const fetchEventPreviewMetadata = adapter.fetchEventPreviewMetadata;
const resolveCachedExternalId = adapter.resolveCachedExternalId;

const uniq = (): string => Math.random().toString(36).slice(2, 10);

function singlePost(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "t3_abc123",
    shortcode: "abc123",
    kind: "text",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: null, likes: 42, comments: 7, shares: null },
    caption: "My devlog post\nsecond line ignored by the title",
    thumbnailUrl: "https://i.redd.it/cover.png",
    ownerId: "t2_owner",
    ownerUsername: "d954mas",
    ...overrides,
  };
}

beforeEach(() => {
  single.next = null;
  single.calls = [];
  providerConfigured = true;
});

describe("reddit paste preview (single-post fetch, adapter seam)", () => {
  it("[12-06] pasting a post URL returns an enriched reddit_post preview + UPSERTs cache + snapshot", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-ok-${uniq()}@t.io` });
    single.next = singlePost();
    const url = "https://www.reddit.com/r/gamedev/comments/abc123/my_devlog/";

    const result = await fetchEventPreviewMetadata(url, {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    // Title = first line of the caption (buildRedditTitle).
    expect(result.title).toBe("My devlog post");
    expect(result.thumbnailUrl).toBe("https://i.redd.it/cover.png");
    expect(result.authorName).toBe("d954mas");
    expect(result.authorUrl).toBe("https://www.reddit.com/user/d954mas");
    // externalId = the t3 fullname (keys reddit_posts.post_id).
    expect(result.externalId).toBe("t3_abc123");

    // The provider was called ONCE with the user-pool origin (cost guardrail).
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.origin).toBe("user");

    // The reddit_posts cache row landed with the polling state + author (purge target).
    const [cached] = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_abc123"));
    expect(cached).toBeDefined();
    expect(cached!.lastPollStatus).toBe("ok");
    expect(cached!.permalink).toBe(url);
    expect(cached!.author).toBe("d954mas");
    expect(cached!.authorFullname).toBe("t2_owner");
    expect(cached!.thumbnailUrl).toBe("https://i.redd.it/cover.png");

    // A snapshot row landed with the D-09 like/comment mapping (score/num_comments).
    const [snap] = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_abc123"));
    expect(snap).toBeDefined();
    expect(snap!.likeCount).toBe(42);
    expect(snap!.commentCount).toBe(7);
  });

  it("[12-06] the preview reserves exactly one user credit (cap counter advances by 1)", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-cap-${uniq()}@t.io` });
    const before = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(before.requests).toBe(0);

    single.next = singlePost({ id: "t3_cap001", shortcode: "cap001" });
    await fetchEventPreviewMetadata("https://www.reddit.com/r/gamedev/comments/cap001/x/", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    // A successful preview wrote exactly ONE cap-counter audit row
    // (event.poll_refreshed / flow=stats_refresh / platform=reddit_account /
    // requests_used=1 — the USER-QUOTA keyspace the banner reads by kind).
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

  it("[12-06] a user parked AT the per-day cap is rejected BEFORE the fetch (no credit burned)", async () => {
    const { env } = await import("../../src/lib/server/config/env.js");
    const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
    const user = await seedUserDirectly({ email: `rdt-preview-capexh-${uniq()}@t.io` });
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
    single.next = singlePost({ id: "t3_capexh", shortcode: "capexh" });

    // The cap gate throws AppError 429 BEFORE the fetch → no credit burned.
    await expect(
      fetchEventPreviewMetadata("https://www.reddit.com/r/gamedev/comments/capexh/x/", {
        userId: user.id,
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ code: "requests_quota_exhausted" });
    expect(single.calls).toHaveLength(0);
    const cached = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_capexh"));
    expect(cached).toHaveLength(0);
  });

  it("[12-06] a deleted/absent post (null provider body) degrades to unavailable (no cache row)", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-null-${uniq()}@t.io` });
    single.next = null; // provider matched no post on page 1 → null

    const result = await fetchEventPreviewMetadata(
      "https://www.reddit.com/r/gamedev/comments/gone01/x/",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );

    expect(result.kind).toBe("unavailable");
    // The provider WAS called (the cap was consulted) but no cache row landed.
    expect(single.calls).toHaveLength(1);
    const cached = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_gone01"));
    expect(cached).toHaveLength(0);
  });

  it("[12-06] an unconfigured provider degrades to unreachable (D-08 default-OFF, no fetch)", async () => {
    providerConfigured = false;
    const user = await seedUserDirectly({ email: `rdt-preview-off-${uniq()}@t.io` });

    const result = await fetchEventPreviewMetadata(
      "https://www.reddit.com/r/gamedev/comments/off001/x/",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );

    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("unreachable");
    expect(result.cause).toBe("reddit_not_configured");
    // Gate short-circuits before the provider AND before the cap consult → no fetch.
    expect(single.calls).toHaveLength(0);
  });

  it("[12-06] a non-Reddit URL degrades to unreachable without a fetch (host-check first)", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-foreign-${uniq()}@t.io` });
    single.next = singlePost();

    const result = await fetchEventPreviewMetadata("https://example.com/r/gamedev/comments/x/y/", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("unreachable");
    expect(result.cause).toBe("url_not_reddit_post");
    expect(single.calls).toHaveLength(0);
  });

  it("[12-06] resolveCachedExternalId re-derives the t3 id from the URL-intrinsic slug", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-cache-${uniq()}@t.io` });
    const url = "https://www.reddit.com/r/gamedev/comments/cache1/my_devlog/";
    single.next = singlePost({ id: "t3_cache1", shortcode: "cache1" });
    await fetchEventPreviewMetadata(url, { userId: user.id, ipAddress: "127.0.0.1" });

    // The Reddit post id is URL-intrinsic (the /comments/<id>/ slug IS the base36 id),
    // so the create boundary re-derives it from the URL, NOT the request body.
    expect(await resolveCachedExternalId(url)).toBe("t3_cache1");
    // A miss (no cache row) still returns the URL-intrinsic id (never null → never a
    // permanently-pending stats badge).
    expect(
      await resolveCachedExternalId("https://www.reddit.com/r/gamedev/comments/nocache/x/"),
    ).toBe("t3_nocache");
    // A non-Reddit / unparseable URL → null (no id derivable).
    expect(await resolveCachedExternalId("https://example.com/not-a-reddit")).toBeNull();
  });
});

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
// type-only import — erased at runtime, so the provider module (which reads env at
// load) is never actually imported into the test process.
import type { RedditSinglePost } from "../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js";
import type { DailyUserRequestAccounting } from "../../src/lib/server/daily-user-quota.js";

interface ScriptedSinglePost {
  next: RedditSinglePost | null;
  /** When set, fetchPostByUrl THROWS this instead of returning `next`. */
  error: Error | null;
  creditReserved: boolean;
  beforeReserve: null | (() => Promise<void>);
  calls: Array<{ url: string; origin?: string }>;
  requestCaps: Array<number | undefined>;
}
const single: ScriptedSinglePost = {
  next: null,
  error: null,
  creditReserved: true,
  beforeReserve: null,
  calls: [],
  requestCaps: [],
};
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
          opts: {
            origin?: "cron" | "user";
            userAccounting?: DailyUserRequestAccounting;
          },
        ): Promise<NormalizedSinglePost | null> {
          single.requestCaps.push(opts.userAccounting?.requestsPerDay);
          await single.beforeReserve?.();
          if (single.creditReserved) {
            const { reserveSocialCredits } =
              await import("../../src/lib/sources/reddit/server/quota.js");
            const permit =
              opts.origin === "user" && opts.userAccounting !== undefined
                ? await reserveSocialCredits({
                    platform: "reddit",
                    provider: "scrapecreators",
                    origin: "user",
                    units: 1,
                    userAccounting: opts.userAccounting,
                  })
                : await reserveSocialCredits({
                    platform: "reddit",
                    provider: "scrapecreators",
                    origin: opts.origin ?? "user",
                    units: 1,
                  });
            if (permit === null) throw new Error("scripted Reddit reservation denied");
          }
          single.calls.push({ url, origin: opts.origin });
          if (single.error !== null) throw single.error;
          return single.next;
        },
        async fetchPosts() {
          return {
            posts: [],
            nextCursor: null,
            endOfFeed: true,
            creditsUsed: 1,
            owner: null,
            droppedCount: 0,
          };
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

function singlePost(overrides: Partial<RedditSinglePost> = {}): RedditSinglePost {
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
    permalink: null,
    subredditSlug: "gamedev",
    ...overrides,
  };
}

beforeEach(() => {
  single.next = null;
  single.error = null;
  single.creditReserved = true;
  single.beforeReserve = null;
  single.calls = [];
  single.requestCaps = [];
  providerConfigured = true;
});

describe("reddit paste preview (single-post fetch, adapter seam)", () => {
  it("[CR-01] concurrent previews at cap-1 admit exactly one paid request", async () => {
    const { env } = await import("../../src/lib/server/config/env.js");
    const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
    const user = await seedUserDirectly({ email: `rdt-preview-race-${uniq()}@t.io` });
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    for (let i = 0; i < cap - 1; i++) {
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

    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    single.beforeReserve = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
    };
    single.next = singlePost({ id: "t3_race01", shortcode: "race01" });

    const results = await Promise.allSettled([
      fetchEventPreviewMetadata("https://www.reddit.com/r/gamedev/comments/race01/a/", {
        userId: user.id,
        ipAddress: "127.0.0.1",
      }),
      fetchEventPreviewMetadata("https://www.reddit.com/r/gamedev/comments/race02/b/", {
        userId: user.id,
        ipAddress: "127.0.0.1",
      }),
    ]);

    expect(single.requestCaps).toEqual([cap, cap]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [loser] = results.filter((result) => result.status === "rejected");
    expect(loser).toMatchObject({
      reason: { code: "requests_quota_exhausted", status: 429 },
    });
    expect(single.calls, "only the transaction winner reaches provider HTTP").toHaveLength(1);
    expect((await getUserQuotaUsedToday(user.id, PLATFORM)).requests).toBe(cap);
  });

  it("[12-06] pasting a post URL returns an enriched reddit_post preview + UPSERTs cache + snapshot", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-ok-${uniq()}@t.io` });
    single.next = singlePost();
    const url = "https://www.reddit.com/r/gamedev/comments/abc123/my_devlog/";

    const result = await fetchEventPreviewMetadata(url, {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    if (result.kind === "unreachable") throw new Error(result.cause);
    expect(result).toMatchObject({ kind: "ok" });
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

  it("[12-06-s] pasting a /s/ share link resolves the post + REWRITES the canonical permalink", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-share-${uniq()}@t.io` });
    const resolved = "https://www.reddit.com/r/itchio/comments/share01/my_shared_post/";
    single.next = singlePost({ id: "t3_share01", shortcode: "share01", permalink: resolved });
    const shareUrl = "https://www.reddit.com/r/itchio/s/IAnrjbuzIT";

    const result = await fetchEventPreviewMetadata(shareUrl, {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    // The provider was handed the SHARE url VERBATIM (the detail endpoint follows the
    // redirect server-side); the preview surfaces the RESOLVED canonical so the saved
    // event stores a parseable slugged post URL, never the opaque share token.
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(shareUrl);
    expect(result.externalId).toBe("t3_share01");
    expect(result.canonicalUrl).toBe(resolved);

    // The cache anchors on the RESOLVED permalink, never the share URL — so the
    // create boundary re-derives the id from the rewritten event URL (#70).
    const [cached] = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_share01"));
    expect(cached).toBeDefined();
    expect(cached!.permalink).toBe(resolved);
    expect(await resolveCachedExternalId(resolved)).toBe("t3_share01");
  });

  it("[12-06-s] a DIRECT permalink paste does NOT rewrite the canonical (no canonicalUrl override)", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-noshare-${uniq()}@t.io` });
    single.next = singlePost({
      id: "t3_direct1",
      shortcode: "direct1",
      permalink: "https://www.reddit.com/r/gamedev/comments/direct1/provider_slug/",
    });
    const pasted = "https://www.reddit.com/r/gamedev/comments/direct1/user_slug/";

    const result = await fetchEventPreviewMetadata(pasted, {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    // The pasted canonical stays authoritative — enrichFromUrl falls back to it.
    expect(result.canonicalUrl).toBeUndefined();
    const [cached] = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_direct1"));
    expect(cached!.permalink).toBe(pasted);
  });

  it("[review-P2] the preview persists the provider's media_type (image card renders before the walk)", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-media-${uniq()}@t.io` });
    // The provider derived an image FORM; the paste must persist it (pre-fix it wrote a
    // hard-coded null, so an image post rendered as a plain text card until a source walk).
    single.next = singlePost({
      id: "t3_img01",
      shortcode: "img01",
      kind: "image",
      mediaType: "image",
      thumbnailUrl: "https://i.redd.it/x.png",
    });
    await fetchEventPreviewMetadata("https://www.reddit.com/r/gamedev/comments/img01/x/", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });
    const [cached] = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_img01"));
    expect(cached!.mediaType, "media_type persisted from the provider (was hard-coded null)").toBe(
      "image",
    );
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

  it("[review-P2] a subreddit-less link (redd.it / reddit.com/comments) is recognition-only: explicit cause, NO fetch, NO cap slot", async () => {
    const user = await seedUserDirectly({ email: `rdt-preview-short-${uniq()}@t.io` });
    single.next = singlePost();

    for (const url of ["https://redd.it/short1", "https://www.reddit.com/comments/short2"]) {
      const result = await fetchEventPreviewMetadata(url, {
        userId: user.id,
        ipAddress: "127.0.0.1",
      });
      expect(result.kind).toBe("unreachable");
      if (result.kind !== "unreachable") throw new Error("unreachable");
      // NOT the generic "unavailable" (indistinguishable from a deleted post): the
      // provider has no lookup-by-id and no subreddit to search, so this can never
      // resolve and the user needs to be told to paste the full permalink.
      expect(result.cause).toBe("reddit_short_link_unsupported");
    }
    // The early-out happens BEFORE both the provider call and the cap gate — pre-fix the
    // cap-counter row was written for a request that never left the process.
    expect(single.calls).toHaveLength(0);
    expect((await getUserQuotaUsedToday(user.id, PLATFORM)).requests).toBe(0);
  });

  it("[review-P1] an ISSUED-but-failed preview fetch still counts against the per-user cap", async () => {
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    const user = await seedUserDirectly({ email: `rdt-preview-err-${uniq()}@t.io` });
    const before = (await getUserQuotaUsedToday(user.id, PLATFORM)).requests;

    // A network/timeout AdapterError has no HTTP status, but reservation happened
    // before fetch and therefore still counts.
    single.error = new AdapterError("network timeout", {
      category: "transient",
    });
    const failed = await fetchEventPreviewMetadata(
      "https://www.reddit.com/r/gamedev/comments/qerr1/x/",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );
    expect(failed.kind).toBe("unreachable");
    expect(
      (await getUserQuotaUsedToday(user.id, PLATFORM)).requests - before,
      "issued-error counts one request",
    ).toBe(1);

    // A resolved-null (post absent from the subreddit's page 1) ALSO issued the fetch.
    single.error = null;
    single.next = null;
    const missed = await fetchEventPreviewMetadata(
      "https://www.reddit.com/r/gamedev/comments/qmiss1/x/",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );
    expect(missed.kind).toBe("unavailable");
    expect(
      (await getUserQuotaUsedToday(user.id, PLATFORM)).requests - before,
      "null-resolve counts one request too",
    ).toBe(2);

    // A reserve DENIAL does not invoke the reservation callback and must NOT count.
    single.creditReserved = false;
    single.error = new AdapterError("budget exhausted", { category: "operator-issue" });
    const denied = await fetchEventPreviewMetadata(
      "https://www.reddit.com/r/gamedev/comments/qdeny1/x/",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );
    expect(denied.kind).toBe("unreachable");
    expect(
      (await getUserQuotaUsedToday(user.id, PLATFORM)).requests - before,
      "a no-issue denial stays uncounted",
    ).toBe(2);
  });
});

// ── HTTP CONTRACT (POST /api/events/preview-url) ──────────────────────────────
//
// The adapter-seam tests above prove the money path; these prove the WIRE contract the
// Add-Event form actually consumes. Restored after a review found the route-level cover
// missing: the adapter can be perfectly correct while enrichFromUrl's Reddit branch maps
// the wrong status (a 429 served as 502 makes the form show "unreachable" for a quota
// stop, and a lost occurredAt silently dates every pasted post "today").
describe("reddit paste preview — HTTP contract (POST /api/events/preview-url)", () => {
  async function previewViaHttp(
    signedCookieValue: string,
    url: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${signedCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("[review-P2] a successful Reddit preview returns 200 with the enriched shape + occurredAt", async () => {
    const user = await seedUserDirectly({ email: `rdt-http-ok-${uniq()}@t.io` });
    single.next = singlePost({ id: "t3_http01", shortcode: "http01" });
    const url = "https://www.reddit.com/r/gamedev/comments/http01/my_devlog/";

    const { status, body } = await previewViaHttp(user.signedSessionCookieValue, url);

    expect(status).toBe(200);
    expect(body.kind).toBe("reddit_post");
    expect(body.title).toBe("My devlog post");
    expect(body.externalId).toBe("http01"); // URL-intrinsic id on the wire
    expect(body.authorName).toBe("d954mas");
    expect(body.authorUrl).toBe("https://www.reddit.com/user/d954mas");
    expect(body.thumbnailUrl).toBe("https://i.redd.it/cover.png");
    // The canonical permalink PRESERVES the title slug (12-06 UAT: the detail
    // endpoint returns a degraded post for slug-less URLs, so the slug is
    // load-bearing for the fetch); the form adopts this value.
    expect(body.canonicalUrl).toBe("https://www.reddit.com/r/gamedev/comments/http01/my_devlog/");
    // The form dates the event from this — a null would silently stamp "today" on a
    // month-old post.
    expect(body.occurredAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("[review-P2] a provider rate limit is served as HTTP 429 reddit_rate_limited (not 502)", async () => {
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    const user = await seedUserDirectly({ email: `rdt-http-429-${uniq()}@t.io` });
    single.error = new AdapterError("ScrapeCreators rate-limited (429)", {
      category: "rate-limited",
    });

    const { status, body } = await previewViaHttp(
      user.signedSessionCookieValue,
      "https://www.reddit.com/r/gamedev/comments/http429/x/",
    );

    expect(status).toBe(429);
    expect(body.error).toBe("reddit_rate_limited");
  });

  it("[review-P2] an exhausted per-user daily quota is served as HTTP 429 requests_quota_exhausted with the reset hint", async () => {
    const { env } = await import("../../src/lib/server/config/env.js");
    const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
    const user = await seedUserDirectly({ email: `rdt-http-cap-${uniq()}@t.io` });
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
    single.next = singlePost({ id: "t3_httpcap", shortcode: "httpcap" });

    const { status, body } = await previewViaHttp(
      user.signedSessionCookieValue,
      "https://www.reddit.com/r/gamedev/comments/httpcap/x/",
    );

    expect(status).toBe(429);
    expect(body.error).toBe("requests_quota_exhausted");
    // The 429 envelope carries the structured hint the banner renders — the UI must not
    // have to parse the human-readable message.
    expect(body.metadata).toMatchObject({ cap, used: cap });
    expect(typeof (body.metadata as { reset_in_seconds?: unknown }).reset_in_seconds).toBe(
      "number",
    );
    expect(single.calls, "the cap gate stops the request before the provider").toHaveLength(0);
  });

  it("[review-P2] a subreddit-less redd.it link is served as HTTP 422 reddit_short_link_unsupported", async () => {
    const user = await seedUserDirectly({ email: `rdt-http-short-${uniq()}@t.io` });
    single.next = singlePost();

    const { status, body } = await previewViaHttp(
      user.signedSessionCookieValue,
      "https://redd.it/httpsh1",
    );

    // 422, not 502: nothing upstream is broken and a retry cannot help — the user needs
    // to paste the full /r/<sub>/comments/<id> permalink (the form explains exactly that).
    expect(status).toBe(422);
    expect(body.error).toBe("reddit_short_link_unsupported");
    expect(single.calls).toHaveLength(0);
  });

  it("[review-P2] a deleted/absent post is served as HTTP 404 reddit_post_not_found", async () => {
    const user = await seedUserDirectly({ email: `rdt-http-404-${uniq()}@t.io` });
    single.next = null; // the provider matched no post

    const { status, body } = await previewViaHttp(
      user.signedSessionCookieValue,
      "https://www.reddit.com/r/gamedev/comments/http404/x/",
    );

    expect(status).toBe(404);
    expect(body.error).toBe("reddit_post_not_found");
  });
});

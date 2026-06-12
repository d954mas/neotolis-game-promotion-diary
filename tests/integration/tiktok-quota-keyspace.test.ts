// TikTok user-quota KEYSPACE parity (Finding 1).
//
// The per-user fair-share cap counter and the /sources + /audit QuotaStatusBanner
// both key on the SOURCE KIND ("tiktok_account") — getUserQuotaUsedToday filters
// audit_log on metadata.platform = adapter.kind, and quota-read.ts loadQuotaPlatforms
// reads getUserQuotaUsedToday(userId, adapter.kind). IG writes "instagram_account"
// (its KIND) for these rows so the banner's per-kind read matches the writers.
//
// Pre-fix the TikTok adapter tagged these USER-QUOTA rows "tiktok" (the SOCIAL-BUDGET
// label), so getUserQuotaUsedToday(userId, "tiktok_account") summed nothing and the
// banner read 0 forever. This suite proves the canon: after a user-triggered backfill
// tick AND a paste preview, BOTH cap-counter rows land under "tiktok_account", the
// cap counter sees them, and loadUserQuota surfaces the usage on the tiktok_account
// row. (The SOCIAL-BUDGET keyspace — "tiktok" — is exercised by tiktok-budget-shared;
// it is deliberately untouched here.)
//
// Integration test — real Postgres via ./helpers.js; the provider seam is mocked at
// provider/registry's getSocialProvider (NEVER the DB).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage, NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedProvider {
  pages: ProviderPage[];
  single: NormalizedSinglePost | null;
}
const provider: ScriptedProvider = { pages: [], single: null };

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
}

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(): Promise<ProviderPage> {
          return provider.pages.shift() ?? emptyPage();
        },
        async fetchPostByUrl(): Promise<NormalizedSinglePost | null> {
          return provider.single;
        },
        async resolveAccount() {
          return { accountId: "acct-keyspace", displayName: "Keyspace" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { loadUserQuota } = await import("../../src/lib/server/services/quota-read.js");
const { tiktokAdapter } = await import("../../src/lib/sources/tiktok/server/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");

// The CANONICAL user-quota keyspace key (= the source kind), NOT "tiktok".
const QUOTA_PLATFORM = "tiktok_account";
const SOCIAL_PLATFORM = "tiktok";
const ACCOUNT = "acct-keyspace";

if (tiktokAdapter.fetchEventPreviewMetadata === undefined) throw new Error("preview missing");
const fetchEventPreviewMetadata = tiktokAdapter.fetchEventPreviewMetadata;

function feedPost(awemeId: string, daysAgo: number) {
  return {
    id: awemeId,
    kind: "short" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: 1000, likes: 50, comments: 5, shares: 10 },
    caption: `keyspace ${awemeId}`,
    thumbnailUrl: `https://cdn.tiktokcdn-us.com/${awemeId}.awebp`,
    permalink: `https://www.tiktok.com/@keyspace/video/${awemeId}`,
  };
}

function singlePost(awemeId: string): NormalizedSinglePost {
  return {
    id: awemeId,
    shortcode: awemeId,
    kind: "short",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: 2000, likes: 100, comments: 10, shares: 20 },
    caption: "preview keyspace",
    thumbnailUrl: "https://cdn.tiktokcdn-us.com/preview.awebp",
    ownerId: ACCOUNT,
    ownerUsername: "keyspace",
  };
}

async function seedSource(userId: string): Promise<string> {
  const [row] = await db
    .insert(dataSources)
    .values({
      userId,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@keyspace",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "keyspace", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
  provider.single = null;
});

describe("tiktok user-quota keyspace parity (Finding 1)", () => {
  it("a user-triggered backfill tags the cap-counter row with the SOURCE KIND, not 'tiktok'", async () => {
    const user = await seedUserDirectly({
      email: `tk-keyspace-bf-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id);

    provider.pages = [
      {
        posts: [feedPost("8100000000000000001", 1)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    // The cap counter (USER-QUOTA keyspace) sees the backfill request.
    const used = await getUserQuotaUsedToday(user.id, QUOTA_PLATFORM);
    expect(used.requests).toBeGreaterThan(0);

    // The SOCIAL-BUDGET label "tiktok" must NOT carry the user-quota row (no leak
    // across keyspaces — pre-fix this is where the count wrongly lived).
    const wrongKeyspace = await getUserQuotaUsedToday(user.id, SOCIAL_PLATFORM);
    expect(wrongKeyspace.requests).toBe(0);
  });

  it("a preview tags its cap-counter row with the source kind too, and BOTH flows accumulate", async () => {
    const user = await seedUserDirectly({
      email: `tk-keyspace-both-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id);

    // 1. User-triggered backfill → one cap-counter row.
    provider.pages = [
      {
        posts: [feedPost("8200000000000000001", 1)],
        nextCursor: null,
        endOfFeed: true,
        creditsUsed: 1,
      },
    ];
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });
    const afterBackfill = await getUserQuotaUsedToday(user.id, QUOTA_PLATFORM);
    const backfillRequests = afterBackfill.requests;
    expect(backfillRequests).toBeGreaterThan(0);

    // 2. A paste preview → exactly one more cap-counter row (+1 request).
    provider.single = singlePost("8200000000000000002");
    const preview = await fetchEventPreviewMetadata(
      "https://www.tiktok.com/@keyspace/video/8200000000000000002",
      { userId: user.id, ipAddress: "127.0.0.1" },
    );
    expect(preview.kind).toBe("ok");

    const afterPreview = await getUserQuotaUsedToday(user.id, QUOTA_PLATFORM);
    expect(afterPreview.requests).toBe(backfillRequests + 1);
  });

  it("loadUserQuota (the QuotaStatusBanner read) surfaces the usage on the tiktok_account row", async () => {
    const user = await seedUserDirectly({
      email: `tk-keyspace-read-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id);

    provider.single = singlePost("8300000000000000001");
    await fetchEventPreviewMetadata("https://www.tiktok.com/@keyspace/video/8300000000000000001", {
      userId: user.id,
      ipAddress: "127.0.0.1",
    });

    const { quotaPlatforms } = await loadUserQuota(user.id);
    // loadQuotaPlatforms iterates allAdapters keyed by adapter.kind — the TikTok row
    // is "tiktok_account". Pre-fix this read 0 (the writer tagged "tiktok"); the fix
    // makes the writer's tag match the read's key.
    const tiktokRow = quotaPlatforms.find((p) => p.kind === QUOTA_PLATFORM);
    expect(tiktokRow).toBeDefined();
    expect(tiktokRow!.today.requests).toBe(1);
    // No phantom "tiktok"-kind row exists (the banner only has a per-adapter-kind row).
    expect(quotaPlatforms.find((p) => p.kind === SOCIAL_PLATFORM)).toBeUndefined();
  });
});

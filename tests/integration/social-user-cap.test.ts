// QUOTA-03 — per-user fair-share request cap (flipped live by Plan 08-06).
//
// LIMIT_SOCIAL_REQUESTS_PER_DAY (default 50): a user who exhausts the cap gets a
// 429 `requests_quota_exhausted` via the EXISTING cross-source
// enforceAdapterUserQuota orchestrator (the same path the refresh-content route
// drives via enforceSourceActionQuota). The cap counter is the audit_log SUM of
// metadata.requests_used over today's capped flows, filtered by
// metadata.platform = "instagram_account" — exactly the tag the IG backfill
// walker writes for the trigger user.
//
// Pitfall 5 (user-pays-once): the trigger user's click charges the cap ONCE; the
// cron continuation pages run with triggerUserId omitted → they enqueue on the
// cron pool and write NO per-user audit row, so they never count against the
// per-user cap. Proven here by driving handleBackfillAccount as cron (no
// triggerUserId) and asserting getUserQuotaUsedToday is unchanged.
//
// Integration test — real Postgres via ./helpers.js; the provider seam is mocked
// at provider/registry's getSocialProvider (NEVER the DB).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

interface ScriptedProvider {
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
}
const provider: ScriptedProvider = { pages: { posts: [], reels: [] } };

// Shared (hoisted) counter so the cap-at-create test can assert resolveAccount is NEVER
// called when the user is already at the daily cap (the guard short-circuits before the
// paid canonicalizeOnCreate resolve).
const spies = vi.hoisted(() => ({ resolveAccountCalls: 0 }));

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
}

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(
          _platform: string,
          _handle: string,
          _cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          const feed = opts.kindFilter ?? "posts";
          const next = provider.pages[feed].shift();
          return next ?? emptyPage();
        },
        async resolveAccount() {
          spies.resolveAccountCalls += 1;
          return { accountId: "acct-cap", displayName: "Cap" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
const { enforceAdapterUserQuota, getUserQuotaUsedToday } =
  await import("../../src/lib/server/services/quota.js");
const { instagramAdapter } = await import("../../src/lib/sources/instagram/server/index.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { env } = await import("../../src/lib/server/config/env.js");

interface ThrownAppError {
  code: string;
  status: number;
  message: string;
  metadata: Record<string, unknown>;
}

const ACCOUNT = "acct-cap";
const PLATFORM = "instagram_account";

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "image" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: null, likes: 5, comments: 1, shares: null },
    caption: `cap caption ${id}`,
    thumbnailUrl: `https://cdn/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

/** Seed N audit rows that the cap counter (getUserQuotaUsedToday) sums: the
 *  EXISTING source.refresh_content_requested verb + a capped flow + the
 *  platform tag + requests_used. One request each → N requests today. */
async function seedSocialRequests(userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await writeAuditStrict({
      userId,
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
}

async function seedSource(userId: string, autoImport = true): Promise<string> {
  const [row] = await db
    .insert(dataSources)
    .values({
      userId,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/capacct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport,
      metadata: { handle: "capacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
  spies.resolveAccountCalls = 0;
});

describe("social per-user request cap (QUOTA-03)", () => {
  it("per-user cap (LIMIT_SOCIAL_REQUESTS_PER_DAY) returns 429 requests_quota_exhausted via enforceAdapterUserQuota", async () => {
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    const user = await seedUserDirectly({
      email: `cap-429-${Math.random().toString(36).slice(2)}@t.io`,
    });

    // Just under cap → the (cap)th request is still allowed.
    await seedSocialRequests(user.id, cap - 1);
    await expect(
      enforceAdapterUserQuota(db, instagramAdapter, user.id, "0.0.0.0", "source-action", {
        platform: PLATFORM,
      }),
    ).resolves.toBeUndefined();

    // At cap → the (cap+1)th user-initiated social request is rejected 429.
    await seedSocialRequests(user.id, 1);
    const used = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(used.requests).toBe(cap);

    try {
      await enforceAdapterUserQuota(db, instagramAdapter, user.id, "0.0.0.0", "source-action", {
        platform: PLATFORM,
      });
      throw new Error("expected enforceAdapterUserQuota to throw 429");
    } catch (e) {
      const err = e as ThrownAppError;
      expect(err.code).toBe("requests_quota_exhausted");
      expect(err.status).toBe(429);
      expect(err.metadata.cap).toBe(cap);
      expect(err.metadata.used).toBe(cap);
      expect(err.message).not.toMatch(/forbidden|permission/i);
    }
  });

  it("the cap is scoped by platform — a different platform's spend does NOT count against the IG cap", async () => {
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    const user = await seedUserDirectly({
      email: `cap-plat-${Math.random().toString(36).slice(2)}@t.io`,
    });

    // Park `cap` requests under a DIFFERENT platform tag (youtube_channel).
    for (let i = 0; i < cap; i++) {
      await writeAuditStrict({
        userId: user.id,
        action: "source.refresh_content_requested",
        ipAddress: "0.0.0.0",
        metadata: {
          kind: "youtube_channel",
          platform: "youtube_channel",
          flow: "incremental",
          requests_used: 1,
          events_inserted: 0,
        },
      });
    }

    // The IG-platform counter is still 0 → enforce passes (per-platform isolation).
    const usedIg = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(usedIg.requests).toBe(0);
    await expect(
      enforceAdapterUserQuota(db, instagramAdapter, user.id, "0.0.0.0", "source-action", {
        platform: PLATFORM,
      }),
    ).resolves.toBeUndefined();
  });

  it("backfill continuation pages run on the cron pool, NOT the per-user cap (Pitfall 5)", async () => {
    const user = await seedUserDirectly({
      email: `cap-cron-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    // Park the user AT cap so any per-user-counted request would be visible.
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    await seedSocialRequests(user.id, cap);
    const before = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(before.requests).toBe(cap);

    // A CRON continuation page (triggerUserId OMITTED) walks the account and
    // imports a post. It must NOT write a per-user audit row → the per-user cap
    // counter is unchanged. (The walker fetches one posts page + one reels page;
    // reels ends immediately.)
    provider.pages.posts = [
      { posts: [post("cron1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
        // triggerUserId intentionally omitted → cron pool.
      },
    });

    // The cron walk imported the post (proves it actually ran)...
    const { events } = await import("../../src/lib/server/db/schema/events.js");
    const inserted = await db.select().from(events).where(eq(events.userId, user.id));
    expect(inserted.map((e) => e.externalId)).toContain("cron1");

    // ...but the per-user cap counter is UNCHANGED (no triggerUserId → no audit).
    const after = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(after.requests).toBe(cap);
  });

  it("a user-triggered walk DOES charge the cap once (the contrast to the cron case)", async () => {
    const user = await seedUserDirectly({
      email: `cap-user1-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    const before = await getUserQuotaUsedToday(user.id, PLATFORM);
    expect(before.requests).toBe(0);

    // A USER-triggered walk (triggerUserId set) writes exactly ONE per-user audit
    // row with requests_used = the pages it fetched → the cap counter advances.
    provider.pages.posts = [
      { posts: [post("u1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const after = await getUserQuotaUsedToday(user.id, PLATFORM);
    // One walk → one audit row → requests_used > 0 (two pages fetched: posts + reels).
    expect(after.requests).toBeGreaterThan(0);

    // Exactly ONE per-user audit row for this user (pays once, not per page).
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.userId, user.id));
    const refreshRows = auditRows.filter(
      (r) =>
        r.action === "source.refresh_content_requested" &&
        (r.metadata as { flow?: string }).flow !== undefined,
    );
    expect(refreshRows).toHaveLength(1);
  });
});

// ── P1-B: the create-time canonicalizeOnCreate (a PAID provider resolveAccount) must be
//    gated by the SAME per-user daily request cap as the widen + refresh-content paths.
//    Pre-fix data-sources.ts only gated adapters with sourceActionsPerWindow (Reddit), so
//    a social-adapter user already AT their daily cap could burn a create-time resolve.
describe("social per-user request cap at SOURCE CREATE (P1-B)", () => {
  interface ThrownCreate {
    code: string;
    status: number;
    metadata: Record<string, unknown>;
  }

  it("a user already at the daily cap is rejected 429 at create — the paid resolve never runs", async () => {
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    const user = await seedUserDirectly({
      email: `create-cap-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // Park the user AT cap under the IG source-kind keyspace.
    await seedSocialRequests(user.id, cap);
    expect((await getUserQuotaUsedToday(user.id, PLATFORM)).requests).toBe(cap);

    try {
      await createSource(
        user.id,
        { kind: "instagram_account", handleUrl: "https://www.instagram.com/atcap/" },
        "0.0.0.0",
      );
      throw new Error("expected createSource to throw at cap");
    } catch (e) {
      const err = e as ThrownCreate;
      expect(err.code).toBe("requests_quota_exhausted");
      expect(err.status).toBe(429);
      expect(err.metadata.cap).toBe(cap);
      expect(err.metadata.used).toBe(cap);
    }

    // The guard runs BEFORE canonicalizeOnCreate → the paid resolveAccount never fired.
    expect(spies.resolveAccountCalls).toBe(0);
    // No phantom source row.
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("a user UNDER the daily cap creates the source normally (resolve runs once)", async () => {
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;
    const user = await seedUserDirectly({
      email: `create-under-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // One below cap → the create is still allowed.
    await seedSocialRequests(user.id, cap - 1);

    const created = await createSource(
      user.id,
      { kind: "instagram_account", handleUrl: "https://www.instagram.com/undercap/" },
      "0.0.0.0",
    );
    expect(created.kind).toBe("instagram_account");
    expect(created.channelId).toBe(ACCOUNT);
    // The create-time resolve ran exactly once (canonicalizeOnCreate was reached).
    expect(spies.resolveAccountCalls).toBe(1);
  });
});

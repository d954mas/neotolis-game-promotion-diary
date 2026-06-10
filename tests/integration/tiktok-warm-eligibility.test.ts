// TikTok warm auto-refresh — eligibility predicate + producer handler (clone of
// instagram-warm-eligibility.test.ts).
//
// selectWarmTikTokPostIds is the cost-bounded selection: event-attached posts that
// are YOUNG (< TIKTOK_WARM_WINDOW_DAYS, default 7) AND STALE (last_polled_at older
// than TIKTOK_WARM_STALENESS_HOURS, default 26), minus genuinely-terminal
// (not_found/private) and persistently-failing (poll_failure_count >= max) posts.
//
// auth_error is NOT excluded (the HTTP seam collapses transient + budget-exhaustion
// into auth_error; excluding it would freeze a post out on a single blip). Bounded
// churn via poll_failure_count instead.
//
// Real Postgres via ./helpers.js; selection asserts via toContain on the per-test
// post ids (the predicate is service-wide). Requirements: PLAT-02.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

let throttle: "ok" | "eighty" | "ninetyfive" = "ok";
vi.mock("../../src/lib/sources/tiktok/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttle };
});

// The warm handler gates on getSocialProvider — control it so the "throttle ok"
// tests aren't accidentally skipped by the test env's unconfigured TikTok.
let providerConfigured = true;
vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSocialProvider: (p: string) =>
      providerConfigured && p === "tiktok" ? ({ name: "scrapecreators" } as never) : null,
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { tiktokPosts, adapterRefreshQueue, events } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { selectWarmTikTokPostIds } =
  await import("../../src/lib/sources/tiktok/server/warm-eligibility.js");
const { handleTikTokWarmRefresh } =
  await import("../../src/lib/sources/tiktok/server/handlers/warm-refresh.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface SeedOpts {
  publishedAgoDays: number;
  lastPolledAgoHours: number | null;
  lastPollStatus?: string | null;
  pollFailureCount?: number;
  attachEvent?: boolean;
  deleteEvent?: boolean;
}

async function seedCandidate(userId: string, opts: SeedOpts): Promise<string> {
  const awemeId = `warm_${uniq()}`;
  const now = Date.now();
  await db.insert(tiktokPosts).values({
    awemeId,
    permalink: `https://www.tiktok.com/@w/video/${awemeId}`,
    publishedAt: new Date(now - opts.publishedAgoDays * DAY),
    lastPolledAt:
      opts.lastPolledAgoHours === null ? null : new Date(now - opts.lastPolledAgoHours * HOUR),
    lastPollStatus: opts.lastPollStatus ?? null,
    pollFailureCount: opts.pollFailureCount ?? 0,
  });
  if (opts.attachEvent !== false) {
    const ev = await createEvent(
      userId,
      {
        kind: "tiktok_post",
        title: "warm",
        externalId: awemeId,
        occurredAt: new Date().toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    if (opts.deleteEvent === true) {
      await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, ev.id));
    }
  }
  return awemeId;
}

beforeEach(() => {
  throttle = "ok";
  providerConfigured = true;
});

describe("selectWarmTikTokPostIds predicate", () => {
  it("[10-04] INCLUDES a young + stale event-attached post (within window, past staleness gate)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-inc-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("[10-04] EXCLUDES a young post that is still FRESH (kept warm by the free account poll)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-fresh-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 1 });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[10-04] EXCLUDES a post older than the warm window (frozen, manual only)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-old-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 10, lastPolledAgoHours: 30 });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[10-04] INCLUDES a never-polled young post (bootstrap)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-null-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 1, lastPolledAgoHours: null });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("[10-04] EXCLUDES terminal not_found / private posts", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-term-${uniq()}@t.io` });
    const gone = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "not_found",
    });
    const priv = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "private",
    });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).not.toContain(gone);
    expect(warm).not.toContain(priv);
  });

  it("[10-04] a post at TIKTOK_WARM_MAX_FAILURES drops out of the warm lane", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-bound-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "auth_error",
      pollFailureCount: 5, // == TIKTOK_WARM_MAX_FAILURES default
    });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[10-04] INCLUDES an auth_error post under the failure bound (transient, NOT frozen)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-auth-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "auth_error",
      pollFailureCount: 1,
    });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("[10-04] EXCLUDES a post with NO alive event (warm refresh is event-attached only)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-noevt-${uniq()}@t.io` });
    const orphan = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      attachEvent: false,
    });
    const deleted = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      deleteEvent: true,
    });
    const warm = await selectWarmTikTokPostIds(new Date());
    expect(warm).not.toContain(orphan);
    expect(warm).not.toContain(deleted);
  });
});

describe("handleTikTokWarmRefresh producer", () => {
  it("[10-04] at throttle 'ok' enqueues a dedup'd service_post row per warm post", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-h-ok-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "ok";

    await handleTikTokWarmRefresh({ id: "warm-job" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(1);
  });

  it("[10-04] at throttle 'eighty' skips entirely (warm is non-essential background spend)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-h-80-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "eighty";

    await handleTikTokWarmRefresh({ id: "warm-job-80" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(0);
  });

  it("[10-04] skips when the provider is unconfigured (lane disabled, no orphan rows)", async () => {
    const u = await seedUserDirectly({ email: `warm-tk-h-noprov-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "ok";
    providerConfigured = false;

    await handleTikTokWarmRefresh({ id: "warm-job-noprov" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(0);
  });
});

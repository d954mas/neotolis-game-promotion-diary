// Twitter/X warm auto-refresh — eligibility predicate + producer handler (clone of
// tiktok-warm-eligibility.test.ts).
//
// selectWarmTwitterPostIds is the cost-bounded selection: event-attached tweets that
// are YOUNG (< TWITTER_WARM_WINDOW_DAYS, default 7) AND STALE (last_polled_at older
// than TWITTER_WARM_STALENESS_HOURS, default 26 — just over the 24h free account-poll
// interval so page-1 tweets never double-pay), minus genuinely-terminal
// (not_found/private) and persistently-failing (poll_failure_count >= max) tweets.
//
// Real Postgres via ./helpers.js. Requirements: TWITTER_WARM_* envelope.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

let throttle: "ok" | "eighty" | "ninetyfive" = "ok";
vi.mock("../../src/lib/sources/twitter/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttle };
});

let providerConfigured = true;
vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSocialProvider: (p: string) =>
      providerConfigured && p === "twitter" ? ({ name: "twitterapi.io" } as never) : null,
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { twitterPosts, adapterRefreshQueue, events } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { selectWarmTwitterPostIds } =
  await import("../../src/lib/sources/twitter/server/warm-eligibility.js");
const { handleTwitterWarmRefresh } =
  await import("../../src/lib/sources/twitter/server/handlers/warm-refresh.js");

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
  const tweetId = `warm_${uniq()}`;
  const now = Date.now();
  await db.insert(twitterPosts).values({
    tweetId,
    permalink: `https://x.com/w/status/${tweetId}`,
    publishedAt: new Date(now - opts.publishedAgoDays * DAY),
    lastPolledAt:
      opts.lastPolledAgoHours === null ? null : new Date(now - opts.lastPolledAgoHours * HOUR),
    lastPollStatus: opts.lastPollStatus ?? null,
    pollFailureCount: opts.pollFailureCount ?? 0,
  });
  if (opts.attachEvent !== false) {
    const ev = await createEvent(
      userId,
      { kind: "twitter_post", title: "warm", externalId: tweetId, occurredAt: new Date().toISOString(), gameIds: [] },
      "127.0.0.1",
    );
    if (opts.deleteEvent === true) {
      await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, ev.id));
    }
  }
  return tweetId;
}

beforeEach(() => {
  throttle = "ok";
  providerConfigured = true;
});

describe("selectWarmTwitterPostIds predicate", () => {
  it("[11-03] selects a young + stale event-attached tweet (within window, past staleness gate)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-inc-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("[11-03] the 26h staleness exceeds the 24h free poll interval so page-1 tweets do not double-pay", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-fresh-${uniq()}@t.io` });
    // A page-1 tweet polled 20h ago (within the 24h free account poll) is NOT yet
    // stale (the 26h gate), so it does not earn a paid warm refresh.
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 20 });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[11-03] excludes tweets older than the warm window (frozen — manual refresh only)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-old-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 10, lastPolledAgoHours: 30 });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[11-03] excludes tweets at TWITTER_WARM_MAX_FAILURES (stop burning credit on a dead tweet)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-bound-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "auth_error",
      pollFailureCount: 5, // == TWITTER_WARM_MAX_FAILURES default
    });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[11-03] excludes terminal not_found / private tweets", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-term-${uniq()}@t.io` });
    const gone = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30, lastPollStatus: "not_found" });
    const priv = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30, lastPollStatus: "private" });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).not.toContain(gone);
    expect(warm).not.toContain(priv);
  });

  it("[11-03] excludes a tweet with NO alive event (warm refresh is event-attached only)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-noevt-${uniq()}@t.io` });
    const orphan = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30, attachEvent: false });
    const deleted = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30, deleteEvent: true });
    const warm = await selectWarmTwitterPostIds(new Date());
    expect(warm).not.toContain(orphan);
    expect(warm).not.toContain(deleted);
  });
});

describe("handleTwitterWarmRefresh producer", () => {
  it("[11-03] at throttle 'ok' enqueues a dedup'd service_post row per warm tweet", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-h-ok-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "ok";

    await handleTwitterWarmRefresh({ id: "warm-job" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(1);
  });

  it("[11-03] at throttle 'eighty' skips entirely (warm is non-essential background spend)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-h-80-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "eighty";

    await handleTwitterWarmRefresh({ id: "warm-job-80" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(0);
  });

  it("[11-03] skips when the provider is unconfigured (lane disabled, no orphan rows)", async () => {
    const u = await seedUserDirectly({ email: `warm-tw-h-noprov-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "ok";
    providerConfigured = false;

    await handleTwitterWarmRefresh({ id: "warm-job-noprov" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(0);
  });
});

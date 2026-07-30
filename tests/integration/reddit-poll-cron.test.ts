// reddit.poll.cron enqueue + budget-throttle skip-gate (Phase 12). The age-tiered
// (active/cold) enqueue and the 80%/95% throttle skip-gate had NO test — a broken gate
// would keep spending the shared prepaid budget past the operator's cap. Drives
// handleRedditPollCron with a stub boss (records enqueues) + a mocked throttle state;
// the candidate/tier SELECT runs against real Postgres.
//
// Requirements: PLAT-04 / D-15 (throttle skip-gate).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { MinimalBoss } from "../../src/lib/sources/adapter.js";

let throttle: "ok" | "eighty" | "ninetyfive" = "ok";

vi.mock("../../src/lib/sources/reddit/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttle };
});

// Provider CONFIGURED — poll-cron short-circuits when getSocialProvider("reddit") is
// null (the D-08 OFF-skip), so the enqueue path under test only runs with it mocked ON.
vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "reddit" ? ({ name: "scrapecreators-reddit" } as never) : null,
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { handleRedditPollCron } =
  await import("../../src/lib/sources/reddit/server/handlers/poll-cron.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

interface SentJob {
  queue: string;
  payload: { channelKey?: string };
}
function stubBoss(sent: SentJob[]): MinimalBoss {
  return {
    async send(queue: string, payload: unknown) {
      sent.push({ queue, payload: payload as { channelKey?: string } });
      return "job-id";
    },
  } as unknown as MinimalBoss;
}

// Seed a reddit_subreddit channel whose newest cached post is `daysAgo` old — the
// active/cold tier is derived from that age (TIER_BOUNDARY_COLD_MS = 28 days).
async function seedChannel(slug: string, daysAgo: number): Promise<void> {
  const u = await seedUserDirectly({ email: `rdt-poll-${uniq()}@t.io` });
  await db.insert(dataSources).values({
    userId: u.id,
    kind: "reddit_subreddit",
    handleUrl: `https://www.reddit.com/r/${slug}`,
    channelId: slug,
    isOwnedByMe: false,
    autoImport: true,
    needsReconnect: false,
  });
  await db.insert(dataSourceChannelState).values({ kind: "reddit_subreddit", channelKey: slug });
  await db.insert(redditPosts).values({
    postId: `t3_${slug}`,
    subredditSlug: slug,
    author: `a_${slug}`,
    authorFullname: `t2_${slug}`,
    title: "seed",
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    lastPolledAt: new Date(Date.now() - daysAgo * DAY),
    lastPollStatus: "ok",
  });
}

beforeEach(() => {
  throttle = "ok";
});

describe("reddit.poll.cron enqueue + throttle skip-gate", () => {
  it("[12-05] active tier enqueues the ACTIVE channel (recent posts), not the cold one", async () => {
    const act = `act${uniq()}`,
      cold = `cld${uniq()}`;
    await seedChannel(act, 1); // newest post 1d → active
    await seedChannel(cold, 40); // newest post 40d → cold (> 28d boundary)
    const sent: SentJob[] = [];

    await handleRedditPollCron({ id: "j1", data: { tier: "active" } }, stubBoss(sent));

    const keys = sent.map((s) => s.payload.channelKey);
    expect(keys).toContain(act);
    expect(keys).not.toContain(cold);
  });

  it("[12-05] cold tier enqueues the COLD channel, not the active one", async () => {
    const act = `act${uniq()}`,
      cold = `cld${uniq()}`;
    await seedChannel(act, 1);
    await seedChannel(cold, 40);
    const sent: SentJob[] = [];

    await handleRedditPollCron({ id: "j2", data: { tier: "cold" } }, stubBoss(sent));

    const keys = sent.map((s) => s.payload.channelKey);
    expect(keys).toContain(cold);
    expect(keys).not.toContain(act);
  });

  it("[12-05] throttle at 95% skips ALL background enqueues (both tiers)", async () => {
    throttle = "ninetyfive";
    const act = `act${uniq()}`;
    await seedChannel(act, 1);
    const sentActive: SentJob[] = [];
    const sentCold: SentJob[] = [];

    await handleRedditPollCron({ id: "j3", data: { tier: "active" } }, stubBoss(sentActive));
    await handleRedditPollCron({ id: "j4", data: { tier: "cold" } }, stubBoss(sentCold));

    expect(sentActive).toHaveLength(0);
    expect(sentCold).toHaveLength(0);
  });

  it("[12-05] throttle at 80% skips COLD (non-essential) but still runs ACTIVE", async () => {
    throttle = "eighty";
    const act = `act${uniq()}`,
      cold = `cld${uniq()}`;
    await seedChannel(act, 1);
    await seedChannel(cold, 40);
    const sentCold: SentJob[] = [];
    const sentActive: SentJob[] = [];

    await handleRedditPollCron({ id: "j5", data: { tier: "cold" } }, stubBoss(sentCold));
    await handleRedditPollCron({ id: "j6", data: { tier: "active" } }, stubBoss(sentActive));

    expect(sentCold, "cold is skipped at 80%").toHaveLength(0);
    expect(
      sentActive.map((s) => s.payload.channelKey),
      "active still runs at 80%",
    ).toContain(act);
  });

  it("[review-P1] tier=warm is a NO-OP (lane disabled — no lookup-by-id endpoint); a stale schedule enqueues nothing", async () => {
    throttle = "ok";
    const act = `wrm${uniq()}`;
    await seedChannel(act, 1);
    const sent: SentJob[] = [];

    await handleRedditPollCron({ id: "j7", data: { tier: "warm" } }, stubBoss(sent));

    expect(sent, "a warm tick must not enqueue anything").toHaveLength(0);
  });

  // REGRESSION: needs_reconnect excludes a channel from this cron, but ONLY a walk
  // clears the flag and ONLY this cron enqueues walks — so a source flagged by a
  // transient upstream 404 was stranded forever, with no "Reconnect" button to press
  // (Reddit has no credentials). A stale flagged channel gets one retry per week.
  it("[review-P2] a needs_reconnect channel is skipped while fresh, and retried once stale", async () => {
    const fresh = `rcf${uniq()}`,
      stale = `rcs${uniq()}`;
    await seedChannel(fresh, 1);
    await seedChannel(stale, 1);
    await db
      .update(dataSources)
      .set({ needsReconnect: true })
      .where(eq(dataSources.channelId, fresh));
    await db
      .update(dataSources)
      .set({ needsReconnect: true })
      .where(eq(dataSources.channelId, stale));
    // Only the stale one has gone past the rehab window.
    await db
      .update(dataSourceChannelState)
      .set({ lastPolledAt: new Date(Date.now() - 1 * DAY) })
      .where(eq(dataSourceChannelState.channelKey, fresh));
    await db
      .update(dataSourceChannelState)
      .set({ lastPolledAt: new Date(Date.now() - 30 * DAY) })
      .where(eq(dataSourceChannelState.channelKey, stale));
    const sent: SentJob[] = [];

    await handleRedditPollCron({ id: "j8", data: { tier: "active" } }, stubBoss(sent));

    const keys = sent.map((s) => s.payload.channelKey);
    expect(keys, "a recently-flagged channel stays excluded").not.toContain(fresh);
    expect(keys, "a long-stale flagged channel gets one rehab walk").toContain(stale);
  });
});

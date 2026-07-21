// reddit.poll.cron enqueue + budget-throttle skip-gate (Phase 12). The age-tiered
// (active/cold) enqueue and the 80%/95% throttle skip-gate had NO test — a broken gate
// would keep spending the shared prepaid budget past the operator's cap. Drives
// handleRedditPollCron with a stub boss (records enqueues) + a mocked throttle state;
// the candidate/tier SELECT runs against real Postgres.
//
// Requirements: PLAT-04 / D-15 (throttle skip-gate).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedUserDirectly } from "./helpers.js";
import type { MinimalBoss } from "../../src/lib/sources/adapter.js";

let throttle: "ok" | "eighty" | "ninetyfive" = "ok";

vi.mock("../../src/lib/sources/reddit/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttle };
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
    const act = `act${uniq()}`, cold = `cld${uniq()}`;
    await seedChannel(act, 1); // newest post 1d → active
    await seedChannel(cold, 40); // newest post 40d → cold (> 28d boundary)
    const sent: SentJob[] = [];

    await handleRedditPollCron({ id: "j1", data: { tier: "active" } }, stubBoss(sent));

    const keys = sent.map((s) => s.payload.channelKey);
    expect(keys).toContain(act);
    expect(keys).not.toContain(cold);
  });

  it("[12-05] cold tier enqueues the COLD channel, not the active one", async () => {
    const act = `act${uniq()}`, cold = `cld${uniq()}`;
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
    const act = `act${uniq()}`, cold = `cld${uniq()}`;
    await seedChannel(act, 1);
    await seedChannel(cold, 40);
    const sentCold: SentJob[] = [];
    const sentActive: SentJob[] = [];

    await handleRedditPollCron({ id: "j5", data: { tier: "cold" } }, stubBoss(sentCold));
    await handleRedditPollCron({ id: "j6", data: { tier: "active" } }, stubBoss(sentActive));

    expect(sentCold, "cold is skipped at 80%").toHaveLength(0);
    expect(sentActive.map((s) => s.payload.channelKey), "active still runs at 80%").toContain(act);
  });
});

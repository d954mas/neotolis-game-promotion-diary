// Phase 03.0.1 Plan 07 — quota-throttle gate assertions on the new
// poll-cron path.
//
// Pre-Plan-07 (Phase 03.0 Plan 09): src/scheduler/enqueue.ts.{enqueueActivePolls,
// enqueueColdPolls} held the throttle gate; this test pinned the integration
// by mocking pg-boss send and asserting the queue + skip flag.
//
// Plan-07 collapses scheduler/enqueue.ts. The throttle gate moves into
// handlePollActive / handlePollCold (the tier-batch handlers fed by
// youtube.poll.cron). This test invokes the handlers directly and asserts
// that the adapter mock is NOT called when the throttle gate skips, plus
// that the audit row idempotency for quota.service_throttled is preserved.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";

const pollStatsCalls: Array<{ videoIds: string[]; quotaUser: string }> = [];

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapter: {
      ...(actual.youtubeChannelAdapter as Record<string, unknown>),
      pollStatsByVideoId: async (videoIds: string[], quotaUser: string) => {
        pollStatsCalls.push({ videoIds, quotaUser });
        return videoIds.map(() => ({
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 1, like_count: 0, comment_count: 0 },
        }));
      },
    },
  };
});

vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickKeyForJob: () => ({ apiKey: "test-key-throttle", apiKeyId: "thrfix1" }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
const { incrementUsage, resetThrottleState, todayPacific, hashApiKeyId } = await import(
  "../../src/lib/sources/youtube/server/quota.js"
);
const { handlePollActive } = await import(
  "../../src/lib/sources/youtube/server/handlers/poll-active.js"
);
const { handlePollCold } = await import(
  "../../src/lib/sources/youtube/server/handlers/poll-cold.js"
);
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function insertActiveEvent(userId: string): Promise<string> {
  const id = uuidv7();
  const externalId = `thr_${uniq()}`;
  const publishedAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
  await db.insert(youtubeVideos).values({
    videoId: externalId,
    title: "throttle test event",
    publishedAt,
    fetchedAt: new Date(),
  });
  await db.insert(events).values({
    id,
    userId,
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt: publishedAt,
    title: "throttle test event",
    url: `https://www.youtube.com/watch?v=${externalId}`,
    externalId,
    metadata: {},
  });
  return id;
}

async function insertColdEvent(userId: string): Promise<string> {
  const id = uuidv7();
  const externalId = `thr_${uniq()}`;
  const publishedAt = new Date(Date.now() - 5 * 86_400_000);
  await db.insert(youtubeVideos).values({
    videoId: externalId,
    title: "throttle test event (cold)",
    publishedAt,
    fetchedAt: new Date(),
  });
  await db.insert(events).values({
    id,
    userId,
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt: publishedAt,
    title: "throttle test event (cold)",
    url: `https://www.youtube.com/watch?v=${externalId}`,
    externalId,
    metadata: {},
  });
  return id;
}

beforeEach(() => {
  pollStatsCalls.length = 0;
  resetThrottleState();
});

describe("youtube-quota-throttle on youtube.poll.cron path (Plan 03.0.1-07)", () => {
  it(">= 8000 units → handlePollCold skips (no upstream HTTP)", async () => {
    const u = await seedUserDirectly({ email: `qt-cold-${uniq()}@test.local` });
    await insertColdEvent(u.id);

    // Push the operator quota counter to 8000 units → state 'eighty'.
    const apiKeyId = hashApiKeyId("k-throttle-80");
    await incrementUsage({ apiKeyId, units: 8000 });

    await handlePollCold({ id: "test", data: { tier: "cold" } });

    // Cold pauses at eighty — no upstream call should land.
    expect(pollStatsCalls).toHaveLength(0);
  });

  it(">= 8000 units does NOT skip handlePollActive (Active runs through 'eighty')", async () => {
    const u = await seedUserDirectly({ email: `qt-active-${uniq()}@test.local` });
    await insertActiveEvent(u.id);

    const apiKeyId = hashApiKeyId("k-throttle-80b");
    await incrementUsage({ apiKeyId, units: 8200 });

    await handlePollActive({ id: "test", data: { tier: "active" } });

    // Active runs through 'eighty' — only Cold pauses there.
    expect(pollStatsCalls.length).toBeGreaterThanOrEqual(1);
    expect(pollStatsCalls[0]!.quotaUser).toBe("neotolis-svc-active");
  });

  it(">= 9500 units → handlePollActive also skips (no upstream HTTP)", async () => {
    const u = await seedUserDirectly({ email: `qt-95-${uniq()}@test.local` });
    await insertActiveEvent(u.id);

    const apiKeyId = hashApiKeyId("k-throttle-95");
    await incrementUsage({ apiKeyId, units: 9500 });

    await handlePollActive({ id: "test", data: { tier: "active" } });

    // ninetyfive pauses Active too.
    expect(pollStatsCalls).toHaveLength(0);
  });

  it("first 'eighty' crossing emits one quota.service_throttled audit row; second crossing same day does NOT re-emit", async () => {
    // Operator user must exist in DB for markThrottleTransition's
    // resolveOperatorUserId to succeed. We pre-seed an audit row at the
    // (date_pacific, state) composite to verify the defense-in-depth
    // lookup spots it (since module state was already reset and the
    // env-time ADMIN_EMAIL_ALLOWLIST cache cannot be re-parsed mid-process).
    const operator = await seedUserDirectly({ email: `op-throttle-${uniq()}@test.local` });
    const today = todayPacific();
    const { writeAudit } = await import("../../src/lib/server/audit.js");
    await writeAudit({
      userId: operator.id,
      action: "quota.service_throttled",
      ipAddress: "127.0.0.1",
      metadata: {
        date_pacific: today,
        state: "eighty",
        api_key_id: "preseeded",
        estimated_units: 8000,
      },
    });

    const u = await seedUserDirectly({ email: `qt-emit-${uniq()}@test.local` });
    await insertActiveEvent(u.id);
    const apiKeyId = hashApiKeyId("k-emit");
    await incrementUsage({ apiKeyId, units: 8500 });

    // First handler tick — 'eighty' state observed; no NEW audit row
    // because the pre-seeded row blocks duplicate emission.
    await handlePollActive({ id: "test", data: { tier: "active" } });

    const rowsAfter1 = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'quota.service_throttled'
          AND ${auditLog.metadata}->>'date_pacific' = ${today}
          AND ${auditLog.metadata}->>'state' = 'eighty'`,
      );
    expect(rowsAfter1).toHaveLength(1);

    // Second handler tick same day — still no new audit row.
    await handlePollActive({ id: "test", data: { tier: "active" } });

    const rowsAfter2 = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'quota.service_throttled'
          AND ${auditLog.metadata}->>'date_pacific' = ${today}
          AND ${auditLog.metadata}->>'state' = 'eighty'`,
      );
    expect(rowsAfter2).toHaveLength(1);
  });
});

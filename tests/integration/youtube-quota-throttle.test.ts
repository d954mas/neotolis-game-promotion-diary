// Phase 3.0 Plan 09 — quota-throttle gate assertions on the scheduler path.
//
// Verifies that getThrottleState's 80% / 95% thresholds short-circuit the
// scheduler enqueue functions correctly. Audit-row idempotency for
// quota.service_throttled is already covered in
// tests/integration/youtube-quota-tracker.test.ts (Plan 03); this file
// pins the integration with the SCHEDULER side.
//
// Tests:
//   1. >= 8000 units in single key → enqueueColdPolls skips; enqueueActivePolls runs
//   2. >= 9500 units in single key → enqueueActivePolls also skips
//   3. First 'eighty' crossing emits one quota.service_throttled audit row
//   4. Second 'eighty' tick same day does NOT re-emit

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";

const sentJobs: Array<{ queue: string; data: Record<string, unknown> }> = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "mock-job-id";
      },
    }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
const { incrementUsage, resetThrottleState, todayPacific, hashApiKeyId } =
  await import("../../src/lib/server/services/youtube-quota-tracker.js");
const { enqueueActivePolls, enqueueColdPolls } = await import("../../src/scheduler/enqueue.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Per-video refactor (2026-05-06): scheduler tier-resolves on
// youtube_videos.published_at (the video's age), not events.occurred_at.
// Each fixture seeds BOTH tables so the scheduler's JOIN finds the
// publishedAt that drives Active/Cold tier classification.
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
  sentJobs.length = 0;
  resetThrottleState();
});

describe("youtube-quota-throttle on scheduler path (Plan 03.0-09)", () => {
  it("Plan 03.0-09: >= 8000 units → enqueueColdPolls skips (returns skipped:true)", async () => {
    const u = await seedUserDirectly({ email: `qt-cold-${uniq()}@test.local` });
    await insertColdEvent(u.id);

    // Push the operator quota counter to 8000 units → state 'eighty'.
    const apiKeyId = hashApiKeyId("k-throttle-80");
    await incrementUsage({ apiKeyId, units: 8000 });

    const result = await enqueueColdPolls();
    expect(result.skipped).toBe(true);
    expect(result.throttleState).toBe("eighty");
    expect(sentJobs.filter((j) => j.queue === "poll.cold")).toHaveLength(0);
  });

  it("Plan 03.0-09: >= 8000 units does NOT skip enqueueActivePolls (Active runs through 'eighty')", async () => {
    const u = await seedUserDirectly({ email: `qt-active-${uniq()}@test.local` });
    await insertActiveEvent(u.id);

    const apiKeyId = hashApiKeyId("k-throttle-80b");
    await incrementUsage({ apiKeyId, units: 8200 });

    const result = await enqueueActivePolls();
    // Active runs through 'eighty' — only Cold is paused.
    expect(result.throttleState).toBe("eighty");
    expect(result.skipped).toBe(false);
    expect(sentJobs.filter((j) => j.queue === "poll.active").length).toBeGreaterThanOrEqual(1);
  });

  it("Plan 03.0-09: >= 9500 units → enqueueActivePolls also skips", async () => {
    const u = await seedUserDirectly({ email: `qt-95-${uniq()}@test.local` });
    await insertActiveEvent(u.id);

    const apiKeyId = hashApiKeyId("k-throttle-95");
    await incrementUsage({ apiKeyId, units: 9500 });

    const result = await enqueueActivePolls();
    expect(result.skipped).toBe(true);
    expect(result.throttleState).toBe("ninetyfive");
    expect(sentJobs.filter((j) => j.queue === "poll.active")).toHaveLength(0);
  });

  it("Plan 03.0-09: first 'eighty' crossing emits one quota.service_throttled audit row; second crossing same day does NOT re-emit", async () => {
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

    // First scheduler tick — 'eighty' state observed; no NEW audit row
    // because the pre-seeded row blocks duplicate emission.
    await enqueueActivePolls();

    const rowsAfter1 = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'quota.service_throttled'
          AND ${auditLog.metadata}->>'date_pacific' = ${today}
          AND ${auditLog.metadata}->>'state' = 'eighty'`,
      );
    // Pre-seeded 1 row + zero duplicates from scheduler.
    expect(rowsAfter1).toHaveLength(1);

    // Second scheduler tick same day — still no new audit row.
    await enqueueActivePolls();

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

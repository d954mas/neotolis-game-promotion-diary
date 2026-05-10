// Phase 03.0.1 Wave 4 (post-UAT) — fetchEventStats cap-check integration test.
//
// createEvent's sync stats-fetch hook must respect the per-user
// requestsPerDay cap. Pre-fix: a user at 100/100 could paste a new
// event and push the audit-log SUM to 101 because fetchEventStats
// burned a unit without consulting the cap. Fixed in a2d8379 — this
// test pins that gate so a future regression (drop the pre-check,
// reorder the gate, lift the cap somewhere else) trips loudly.
//
// Mocks the YouTube adapter's fetchEventStats so we don't need real
// HTTP, but verifies the AUDIT-LOG side-effect — i.e., the cap query
// (services/quota.ts getUserQuotaUsedToday) reflects the result the
// way the endpoints expect.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql, eq, and } from "drizzle-orm";

let fetchEventStatsCallCount = 0;

vi.mock("../../src/lib/sources/youtube/server/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const real = actual.youtubeAdapter as Record<string, unknown>;
  return {
    ...actual,
    youtubeAdapter: {
      ...real,
      // Track invocations + emit a stats_refresh audit row mirroring the
      // real impl so the cap counter ticks correctly. We don't make HTTP.
      fetchEventStats: async (
        externalId: string,
        ctx: { userId: string },
      ): Promise<{ viewCount: number; likeCount: number; commentCount: number }> => {
        fetchEventStatsCallCount += 1;
        const { writeAudit } = await import("../../src/lib/server/audit.js");
        await writeAudit({
          userId: ctx.userId,
          action: "event.poll_refreshed",
          ipAddress: "0.0.0.0",
          metadata: {
            external_id: externalId,
            kind: "youtube_video",
            platform: "youtube_channel",
            flow: "stats_refresh",
            requests_used: 1,
            events_inserted: 0,
          },
        });
        return { viewCount: 100, likeCount: 10, commentCount: 5 };
      },
    },
  };
});

const { createEvent } = await import("../../src/lib/server/services/events.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

const YOUTUBE_REQUESTS_PER_DAY = 100;

async function seedCappedAuditRows(userId: string, count: number): Promise<void> {
  // Each row counts 1 toward the requestsPerDay cap (flow=stats_refresh,
  // requests_used=1, platform=youtube_channel).
  for (let i = 0; i < count; i++) {
    await db.insert(auditLog).values({
      userId,
      action: "event.poll_refreshed",
      ipAddress: "0.0.0.0",
      metadata: {
        external_id: `seed_${uniq()}`,
        kind: "youtube_video",
        platform: "youtube_channel",
        flow: "stats_refresh",
        requests_used: 1,
        events_inserted: 0,
      },
    });
  }
}

describe("createEvent → fetchEventStats cap-check", () => {
  beforeEach(() => {
    fetchEventStatsCallCount = 0;
  });

  it("user under cap: createEvent triggers fetchEventStats", async () => {
    const u = await seedUserDirectly({ email: `fes-under-${uniq()}@test.local` });
    // Simulate 50/100 — well under cap.
    await seedCappedAuditRows(u.id, 50);
    const before = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(before.requests).toBe(50);

    await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "test",
        url: "https://www.youtube.com/watch?v=AbCdEfGhIjK",
        externalId: "AbCdEfGhIjK",
      },
      "127.0.0.1",
    );

    expect(fetchEventStatsCallCount).toBe(1);
    const after = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(after.requests).toBe(51); // +1 for the stats fetch
  });

  it("user at cap: createEvent SKIPS fetchEventStats — paste still succeeds", async () => {
    const u = await seedUserDirectly({ email: `fes-at-${uniq()}@test.local` });
    // Simulate 100/100 — at cap.
    await seedCappedAuditRows(u.id, YOUTUBE_REQUESTS_PER_DAY);
    const before = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(before.requests).toBe(YOUTUBE_REQUESTS_PER_DAY);

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "test",
        url: "https://www.youtube.com/watch?v=XyZ12345678",
        externalId: "XyZ12345678",
      },
      "127.0.0.1",
    );

    // Event ROW still created — paste UX unaffected by cap on stats fetch.
    expect(ev.id).toBeDefined();
    expect(ev.externalId).toBe("XyZ12345678");
    const [eventRow] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(eventRow).toBeDefined();

    // BUT: fetchEventStats was NOT called — cap pre-check skipped it.
    expect(fetchEventStatsCallCount).toBe(0);
    // And the cap counter stayed at 100 — no extra burn.
    const after = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(after.requests).toBe(YOUTUBE_REQUESTS_PER_DAY);
  });

  it("user over cap (101/100 from prior bug): still skips, doesn't double-down", async () => {
    const u = await seedUserDirectly({ email: `fes-over-${uniq()}@test.local` });
    // Simulate already-over state (e.g., from pre-fix when cap was bypassed).
    await seedCappedAuditRows(u.id, 105);

    await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "test",
        url: "https://www.youtube.com/watch?v=Kl0987654Mn",
        externalId: "Kl0987654Mn",
      },
      "127.0.0.1",
    );

    expect(fetchEventStatsCallCount).toBe(0);
    const after = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(after.requests).toBe(105);
  });

  it("under cap: writes last_user_refresh_at to event.metadata", async () => {
    // Phase 03.0.1 Wave 4 — fetchEventStats success path also stamps
    // events.metadata.last_user_refresh_at so RefreshNowButton's
    // cooldown gate picks up; without this, immediate post-paste click
    // would re-burn a unit (no cooldown active).
    const u = await seedUserDirectly({ email: `fes-cool-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "test",
        url: "https://www.youtube.com/watch?v=Cooldn1234X",
        externalId: "Cooldn1234X",
      },
      "127.0.0.1",
    );

    const [refreshed] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    const meta = refreshed!.metadata as { last_user_refresh_at?: string } | null;
    expect(meta?.last_user_refresh_at).toBeDefined();
    const stamp = new Date(meta!.last_user_refresh_at!);
    expect(Date.now() - stamp.getTime()).toBeLessThan(5_000);
  });
});

// Suppress unused-export warning for sql (kept for future raw-SQL extension).
void sql;

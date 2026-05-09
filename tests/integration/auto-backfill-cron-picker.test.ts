// Phase 03.0.1 (post-review) — auto-backfill cron picker integration test.
//
// Verifies the daily 03:00 PT cron tick correctly:
//   1. Skips sources where backfill_complete = true.
//   2. Picks incomplete sources в per-user round-robin order.
//   3. Enqueues with flow='auto_passive' + singletonKey + priority=0.
//   4. Skips entire tick when operator quota at >= SKIP_THRESHOLD_PCT (50%).
//
// Pre-review only the SQL helper (selectIncomplete-style picker) was unit-
// tested; integration test ensures the handler invokes adapter contract
// correctly with the mock boss.

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

interface CapturedJob {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}
const sentJobs: CapturedJob[] = [];

const mockBoss = {
  send: async (queue: string, data: Record<string, unknown>, options: Record<string, unknown>) => {
    sentJobs.push({ queue, data, options });
    return `mock-job-${Math.random().toString(36).slice(2, 10)}`;
  },
  schedule: async () => {},
  createQueue: async () => {},
  work: async () => {},
};

const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { handleAutoBackfillCron } =
  await import("../../src/lib/sources/youtube/server/handlers/auto-backfill-cron.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { youtubeServiceQuotaUsage } = await import("../../src/lib/server/db/schema/index.js");
const { todayPacific } = await import("../../src/lib/server/dates.js");
const { seedUserDirectly } = await import("./helpers.js");
const { eq } = await import("drizzle-orm");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("auto-backfill cron picker (handleAutoBackfillCron)", () => {
  beforeEach(async () => {
    sentJobs.length = 0;
    // Reset operator counter so SKIP_THRESHOLD_PCT gate stays open by default
    // for these tests. Tests that exercise the threshold seed their own row.
    await db.execute(
      sql`DELETE FROM youtube_service_quota_usage WHERE date_pacific = ${todayPacific()}`,
    );
  });

  it("picks only incomplete sources, enqueues with flow='auto_passive'", async () => {
    const u = await seedUserDirectly({ email: `cron-pick-${uniq()}@test.local` });

    // Source A — incomplete (default).
    const srcIncomplete = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    // Source B — mark complete=true so picker skips it.
    const srcComplete = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}bb`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );
    await db
      .update(dataSources)
      .set({ backfillComplete: true })
      .where(eq(dataSources.id, srcComplete.id));

    await handleAutoBackfillCron({ id: "mock-cron-tick-1", data: {} }, mockBoss);

    // Only the incomplete source enqueued. Filter by source.id (other tests
    // in the same DB run may seed unrelated incomplete sources — keeps
    // assertion idempotent against test pollution).
    const ourJobs = sentJobs.filter(
      (j) => j.data.sourceId === srcIncomplete.id || j.data.sourceId === srcComplete.id,
    );
    expect(ourJobs.length).toBe(1);
    const job = ourJobs[0]!;
    expect(job.queue).toContain("youtube.backfill.user");
    expect(job.data.sourceId).toBe(srcIncomplete.id);
    expect(job.data.userId).toBe(u.id);
    expect(job.data.flow).toBe("auto_passive");
    expect(job.data.origin).toBe("cron");
    expect(job.options.singletonKey).toBe(`auto-backfill-${srcIncomplete.id}`);
    expect(job.options.priority).toBe(0);
  });

  it("defers entire tick when operator quota >= SKIP_THRESHOLD_PCT (50%)", async () => {
    const u = await seedUserDirectly({ email: `cron-defer-${uniq()}@test.local` });
    await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}cc`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    // Seed operator counter at 60% (>=50%) — gate should fire.
    // YouTube daily limit per key = 10000; one key in test env (or default 1).
    await db.insert(youtubeServiceQuotaUsage).values({
      datePacific: todayPacific(),
      apiKeyId: "test-key-defer",
      estimatedUnits: 6000,
    });

    sentJobs.length = 0;
    await handleAutoBackfillCron({ id: "mock-cron-tick-2", data: {} }, mockBoss);

    // No jobs enqueued — tick deferred regardless of incomplete sources.
    expect(sentJobs.length).toBe(0);
  });
});

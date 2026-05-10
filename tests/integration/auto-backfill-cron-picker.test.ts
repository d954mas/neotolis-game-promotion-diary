// Phase 03.0.1 (post-review) — auto-backfill cron picker integration test.
// Phase 03.0.1 Wave 2 — channel-scoped picker rewrite.
//
// Verifies the daily 03:00 PT cron tick correctly:
//   1. Skips channels where data_source_channel_state.backfill_complete = true.
//   2. Picks DISTINCT channel_key per active subscriber (channel-scoped).
//   3. Enqueues with flow='auto_passive', kind+channelKey payload,
//      singletonKey by channelKey, priority=0.
//   4. Skips entire tick when operator quota at >= SKIP_THRESHOLD_PCT (50%).

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
const { markChannelBackfillComplete } =
  await import("../../src/lib/server/services/channel-state.js");
const { handleAutoBackfillCron } =
  await import("../../src/lib/sources/youtube/server/handlers/auto-backfill-cron.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { youtubeServiceQuotaUsage } = await import("../../src/lib/server/db/schema/index.js");
const { todayPacific } = await import("../../src/lib/server/dates.js");
const { seedUserDirectly } = await import("./helpers.js");

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

    // Source B — mark its channel complete=true so picker skips it.
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
    await markChannelBackfillComplete("youtube_channel", srcComplete.channelId!);

    await handleAutoBackfillCron({ id: "mock-cron-tick-1", data: {} }, mockBoss);

    // Only the incomplete channel enqueued. Filter by channelKey (other tests
    // in the same DB run may seed unrelated incomplete channels — keeps
    // assertion idempotent against test pollution).
    const ourJobs = sentJobs.filter(
      (j) =>
        j.data.channelKey === srcIncomplete.channelId ||
        j.data.channelKey === srcComplete.channelId,
    );
    expect(ourJobs.length).toBe(1);
    const job = ourJobs[0]!;
    expect(job.queue).toBe("youtube.backfill.channel");
    expect(job.data.kind).toBe("youtube_channel");
    expect(job.data.channelKey).toBe(srcIncomplete.channelId);
    expect(job.data.flow).toBe("auto_passive");
    expect(job.data.depthBoundIso).toBe("1970-01-01T00:00:00Z");
    // No triggerUserId for cron flows (operator pool, no per-user audit).
    expect(job.data.triggerUserId).toBeUndefined();
    expect(job.options.singletonKey).toBe(`auto-backfill-${srcIncomplete.channelId}`);
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
      poolKind: "cron",
      estimatedUnits: 6000,
    });

    sentJobs.length = 0;
    await handleAutoBackfillCron({ id: "mock-cron-tick-2", data: {} }, mockBoss);

    // No jobs enqueued — tick deferred regardless of incomplete sources.
    expect(sentJobs.length).toBe(0);
  });
});

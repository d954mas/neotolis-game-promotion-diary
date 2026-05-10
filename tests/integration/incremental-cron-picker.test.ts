// Phase 03.0.1 Wave 3 — daily incremental cron picker integration test.
//
// Verifies the daily 04:00 PT cron correctly:
//   1. Picks BOTH complete and incomplete channels (vs auto-backfill cron
//      which only picks incomplete) — closes the new-upload-discovery gap.
//   2. Skips channels with NO active auto_import=true subscriber.
//   3. Enqueues channel-scoped backfill jobs with depthBoundIso bounded
//      to ~14 days back — page-1 walk = 1 quota unit.
//   4. Skips entire tick when operator quota >= SKIP_THRESHOLD_PCT (50%).

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
const { handleIncrementalCron } =
  await import("../../src/lib/sources/youtube/server/handlers/incremental-cron.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { youtubeServiceQuotaUsage } = await import("../../src/lib/server/db/schema/index.js");
const { todayPacific } = await import("../../src/lib/server/dates.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("incremental cron picker (handleIncrementalCron)", () => {
  beforeEach(async () => {
    sentJobs.length = 0;
    await db.execute(
      sql`DELETE FROM youtube_service_quota_usage WHERE date_pacific = ${todayPacific()}`,
    );
  });

  it("picks both complete AND incomplete channels with auto_import subscribers", async () => {
    const u = await seedUserDirectly({ email: `inc-${uniq()}@test.local` });

    // Channel A — incomplete (default state).
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

    // Channel B — mark complete=true.
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

    await handleIncrementalCron({ id: "mock-tick-1", data: {} }, mockBoss);

    // BOTH channels enqueued — incremental cron does not filter by complete.
    const ourJobs = sentJobs.filter(
      (j) =>
        j.data.channelKey === srcIncomplete.channelId ||
        j.data.channelKey === srcComplete.channelId,
    );
    expect(ourJobs.length).toBe(2);
    for (const job of ourJobs) {
      expect(job.queue).toBe("youtube.backfill.channel");
      expect(job.data.kind).toBe("youtube_channel");
      expect(job.data.flow).toBe("auto_passive");
      expect(job.data.triggerUserId).toBeUndefined();
      // depthBoundIso ≈ now - 14 days. We just check it parses to a date
      // less than 30 days old.
      const bound = new Date(job.data.depthBoundIso as string);
      const ageDays = (Date.now() - bound.getTime()) / (24 * 60 * 60 * 1000);
      expect(ageDays).toBeGreaterThan(7);
      expect(ageDays).toBeLessThan(30);
      expect((job.options.singletonKey as string).startsWith("incremental-")).toBe(true);
      expect(job.options.priority).toBe(0);
    }
  });

  it("skips channels with no auto_import=true subscriber", async () => {
    const u = await seedUserDirectly({ email: `inc-noimp-${uniq()}@test.local` });

    // Auto-import OFF — picker must skip this channel.
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}cc`,
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );

    await handleIncrementalCron({ id: "mock-tick-2", data: {} }, mockBoss);

    const ourJobs = sentJobs.filter((j) => j.data.channelKey === src.channelId);
    expect(ourJobs.length).toBe(0);
  });

  it("defers entire tick when operator quota >= 50%", async () => {
    const u = await seedUserDirectly({ email: `inc-defer-${uniq()}@test.local` });
    await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}dd`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    await db
      .insert(youtubeServiceQuotaUsage)
      .values({
        datePacific: todayPacific(),
        apiKeyId: `defer-test-${uniq()}`,
        poolKind: "cron",
        estimatedUnits: 6000,
      })
      .onConflictDoNothing();

    await handleIncrementalCron({ id: "mock-tick-3", data: {} }, mockBoss);

    // Tick deferred — no enqueue.
    expect(sentJobs.length).toBe(0);
  });
});

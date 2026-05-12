// Phase 03.0.1 (post-review) — end-to-end catch-up flow integration test.
// Phase 03.0.1 Wave 2 — channel-scoped polling rewrite.
//
// Pre-review the suite covered each layer in isolation (endpoint cap-check,
// state helpers, computeSinceForRefresh) but never wired them together. The
// P1 platform-leak bug (refresh-poll wrote `kind=youtube_video`, cap query
// filtered for `kind=youtube_channel` — never matched) survived four review
// passes precisely because no test traced data through the pipeline.
//
// Wave 2 makes the flow channel-scoped. Path:
//
//   1. POST /api/sources/:id/refresh-content
//      - intent audit row written (no flow field)
//      - boss.send invoked with YOUTUBE_BACKFILL_CHANNEL + payload
//        { kind, channelKey, triggerUserId, depthBoundIso, flow }
//      (Phase 03.0.3 P1: the pre-refactor channel-state reset call was
//      removed — three-branch since-derivation in backfill-channel.ts
//      handles the steady-state vs deep-walk decision lazily at
//      walk-time. See D-D1 / D-#29-6.)
//
//   2. handleBackfillChannel invoked
//      - resolves all subscribers for (kind, channelKey)
//      - calls adapter.pollContent (mocked here)
//      - fans out events INSERT per subscriber (1 in this test)
//      - updates channel state: last_polled_at, frontier, complete, cursor
//      - writes ONE completion audit row attributed to triggerUserId
//
//   3. getUserQuotaUsedToday(triggerUserId, kind) reflects consumption
//      - cap counter filters on flow + platform; cron flows don't count
//
// Mocks getBoss (no live pg-boss) and youtubeChannelAdapterCore.pollContent
// (deterministic event payload) — same pattern as scheduler-enqueue.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";

interface CapturedJob {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}

const sentJobs: CapturedJob[] = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (
        queue: string,
        data: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        sentJobs.push({ queue, data, options });
        return `mock-job-${Math.random().toString(36).slice(2, 10)}`;
      },
      schedule: async () => {},
      createQueue: async () => {},
      work: async () => {},
    }),
  };
});

interface RawEventStub {
  externalId: string;
  occurredAt: Date;
  title: string;
  url: string;
  metadata: Record<string, unknown>;
}

const pollContentResults: RawEventStub[] = [];
let pollContentEndOfPlaylist = false;

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const core = actual.youtubeChannelAdapterCore as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...core,
      pollContent: async () => ({
        events: pollContentResults.slice(),
        unitsUsed: 1,
        endOfPlaylist: pollContentEndOfPlaylist,
      }),
    },
  };
});

const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { handleBackfillChannel } =
  await import("../../src/lib/sources/youtube/server/handlers/backfill-channel.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { getChannelState } = await import("../../src/lib/server/services/channel-state.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("end-to-end channel-scoped catch-up flow", () => {
  beforeEach(() => {
    sentJobs.length = 0;
    pollContentResults.length = 0;
    pollContentEndOfPlaylist = false;
  });

  it("user click → endpoint → channel worker → events INSERTed → cap counter increments", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `e2e-${uniq()}@test.local` });
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}aa`;
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    // createSource may itself enqueue a channel-context backfill job via
    // onSourceCreated. We care only about jobs from refresh-content click.
    sentJobs.length = 0;

    pollContentResults.push(
      {
        externalId: `vid_${uniq()}`,
        occurredAt: new Date("2026-04-01T00:00:00Z"),
        title: "A",
        url: "https://www.youtube.com/watch?v=A",
        metadata: {},
      },
      {
        externalId: `vid_${uniq()}`,
        occurredAt: new Date("2026-04-15T00:00:00Z"),
        title: "B",
        url: "https://www.youtube.com/watch?v=B",
        metadata: {},
      },
      {
        externalId: `vid_${uniq()}`,
        occurredAt: new Date("2026-05-01T00:00:00Z"),
        title: "C",
        url: "https://www.youtube.com/watch?v=C",
        metadata: {},
      },
    );

    // Set target_since so worker has reason to walk.
    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date("2026-03-01T00:00:00Z") })
      .where(eq(dataSources.id, src.id));

    // Step 1 — user clicks refresh-content.
    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { enqueued: boolean; queue: string; jobId: string };
    expect(body.enqueued).toBe(true);
    expect(body.queue).toBe("youtube.backfill.channel");

    // Endpoint enqueued exactly one channel-scoped job.
    expect(sentJobs.length).toBe(1);
    const enqueuedJob = sentJobs[0]!;
    expect(enqueuedJob.queue).toBe("youtube.backfill.channel");
    expect(enqueuedJob.data.kind).toBe("youtube_channel");
    expect(enqueuedJob.data.channelKey).toBe(channelId);
    expect(enqueuedJob.data.triggerUserId).toBe(u.id);
    expect(enqueuedJob.data.flow).toBe("incremental");

    // Pre-worker: cap counter is 0 (intent rows not counted — flow IS NULL).
    let used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBe(0);
    expect(used.events).toBe(0);

    // Step 2 — worker processes the job.
    await handleBackfillChannel({
      id: "mock-job-1",
      data: enqueuedJob.data as {
        kind: "youtube_channel";
        channelKey: string;
        triggerUserId: string;
        depthBoundIso: string;
        flow: "incremental" | "historical" | "auto_passive" | "initial";
      },
    });

    // Events landed in the table, scoped to (user, source).
    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.sourceId, src.id)));
    expect(eventRows.length).toBe(3);
    const titles = eventRows.map((r) => r.title).sort();
    expect(titles).toEqual(["A", "B", "C"]);

    // Phase 03.0.1 Wave 4 (post-UAT prod hotfix) — backfill-channel
    // populates youtube_videos cache for every fetched event. Pre-fix
    // the channel-scoped polling path INSERTed events but left the cache
    // empty, so PollingBadge tier resolution returned 'pending' and
    // poll-active/poll-cold cron skipped the videos forever (no stats
    // ever landed). Assert the cache is populated post-walk so a
    // regression dropping the UPSERT block is caught.
    const externalIds = eventRows
      .map((r) => r.externalId)
      .filter((x): x is string => typeof x === "string");
    expect(externalIds.length).toBe(3);
    const cacheRows = await db
      .select()
      .from((await import("../../src/lib/sources/youtube/server/schema/index.js")).youtubeVideos)
      .where(
        (await import("drizzle-orm")).inArray(
          (await import("../../src/lib/sources/youtube/server/schema/index.js")).youtubeVideos
            .videoId,
          externalIds,
        ),
      );
    expect(cacheRows.length).toBe(3);
    for (const row of cacheRows) {
      expect(row.publishedAt).not.toBeNull();
      expect(row.title).toBeTruthy();
      expect(row.channelId).toBe(channelId);
      // last_polled_at intentionally NULL — backfill-channel only
      // populates cache (snippet); poll-active/poll-cold cron will fetch
      // stats and stamp last_polled_at. Distinguishes from the
      // channel-context-backfill seed path which DOES stamp it.
      expect(row.lastPolledAt).toBeNull();
    }

    // Channel state advanced.
    //
    // PR #31 Codex P1 #2 follow-up — in deep-mode walks with
    // endOfPlaylist=false (mock returns no nextPageToken so the
    // worker treats it as walkedPastSince), frontier advances to
    // `since` (= target = 2026-03-01), NOT to the oldest collected
    // event (2026-04-01). Rationale: items collected in deep mode
    // have publishedAt > since by construction; setting frontier to
    // oldest-collected would understate the walked depth and force
    // a redundant deep re-walk if the user later widened target to,
    // say, 2026-03-15 (we've already covered that range). Using
    // `since` gives the most accurate "we walked AT LEAST to here"
    // assertion. (If the mock returned endOfPlaylist=true the test
    // would have asserted oldest-collected, the legitimate channel
    // floor — see the !endOfPlaylist branch in
    // backfill-channel.ts:496-518.)
    const channelState = await getChannelState("youtube_channel", channelId);
    expect(channelState).toBeDefined();
    expect(channelState!.lastPolledAt).not.toBeNull();
    expect(channelState!.backfillOldestAt).not.toBeNull();
    expect(channelState!.backfillOldestAt!.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(channelState!.backfillComplete).toBe(false);

    // Completion audit row attributed to trigger user.
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const completion = auditRows.find((r) => {
      const m = r.metadata as Record<string, unknown> | null;
      return (
        r.action === "source.refresh_content_requested" &&
        m?.flow !== undefined &&
        m?.events_inserted !== undefined
      );
    });
    expect(completion, "completion audit row missing").toBeDefined();
    const meta = completion!.metadata as Record<string, unknown>;
    expect(meta.platform).toBe("youtube_channel");
    expect(meta.kind).toBe("youtube_channel");
    expect(meta.channel_key).toBe(channelId);
    expect(["incremental", "historical"]).toContain(meta.flow as string);
    expect(Number(meta.requests_used)).toBeGreaterThan(0);
    expect(Number(meta.events_inserted)).toBe(3);

    // Cap counter reflects the worker's audit row.
    used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBeGreaterThan(0);
    expect(used.events).toBe(3);
  });

  it("empty pollContent result + endOfPlaylist → channel.backfill_complete=true + cap counter logs the empty pull", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `e2e-empty-${uniq()}@test.local` });
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}aa`;
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    sentJobs.length = 0;
    pollContentResults.length = 0; // empty
    pollContentEndOfPlaylist = true; // platform confirmed nothing more

    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date("2026-03-01T00:00:00Z") })
      .where(eq(dataSources.id, src.id));

    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(202);

    const enqueuedJob = sentJobs[0]!;
    await handleBackfillChannel({
      id: "mock-job-empty",
      data: enqueuedJob.data as {
        kind: "youtube_channel";
        channelKey: string;
        triggerUserId: string;
        depthBoundIso: string;
        flow: "incremental" | "historical" | "auto_passive" | "initial";
      },
    });

    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.sourceId, src.id)));
    expect(eventRows.length).toBe(0);

    const channelState = await getChannelState("youtube_channel", channelId);
    expect(channelState!.backfillComplete).toBe(true);
    expect(channelState!.lastPolledAt).not.toBeNull();

    // Cap counter still increments — the empty page itself burned 1 unit.
    const used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBeGreaterThan(0);
    expect(used.events).toBe(0);
  });
});

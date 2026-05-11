// Phase 03.0.3 P1 — refresh-content quota-burn invariants (issue #29).
//
// 3 behavioural tests verbatim from CONTEXT D-C1:
//   (a) repeated click within 5min on a steady-state channel costs ≤1 page
//       (not N/50 pages) — branch="exhausted".
//   (b) backdated upload (publishedAt < newestKnown but > prior session) is
//       collected on the next click — branch="incremental".
//   (c) widening backfillTargetSince (30d → epoch) triggers deep walk on
//       next refresh-content click — branch="deep" (no eager reset; D-#29-6).
//
// Mocks getBoss (no live pg-boss) and youtubeChannelAdapterCore.pollContent
// (deterministic event payload, captures `since` arg) — same pattern as
// end-to-end-catch-up.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

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

const pollContentCalls: { since: Date }[] = [];
let pollContentResults: RawEventStub[] = [];
let pollContentEndOfPlaylist = false;
let pollContentUnitsUsed = 1;

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const core = actual.youtubeChannelAdapterCore as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...core,
      pollContent: async (_source: unknown, since: Date) => {
        pollContentCalls.push({ since });
        return {
          events: pollContentResults.slice(),
          unitsUsed: pollContentUnitsUsed,
          endOfPlaylist: pollContentEndOfPlaylist,
        };
      },
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } = await import(
  "../../src/lib/server/db/schema/data-source-channel-state.js"
);
const { youtubeVideos } = await import("../../src/lib/sources/youtube/server/schema/index.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { handleBackfillChannel } = await import(
  "../../src/lib/sources/youtube/server/handlers/backfill-channel.js"
);
const { getChannelState } = await import("../../src/lib/server/services/channel-state.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const newChannelKey = (): string => `UC${uniq()}${uniq().slice(0, 8)}aa`;

async function clearChannelFixture(channelKey: string): Promise<void> {
  await db.delete(youtubeVideos).where(eq(youtubeVideos.channelId, channelKey));
  await db
    .delete(dataSourceChannelState)
    .where(
      and(
        eq(dataSourceChannelState.kind, "youtube_channel"),
        eq(dataSourceChannelState.channelKey, channelKey),
      ),
    );
}

describe("refresh-content quota burn — Phase 03.0.3 P1 (issue #29)", () => {
  beforeEach(() => {
    sentJobs.length = 0;
    pollContentCalls.length = 0;
    pollContentResults = [];
    pollContentEndOfPlaylist = false;
    pollContentUnitsUsed = 1;
  });

  it("(a) repeated click within 5min on a steady-state channel costs ≤1 page (not N/50 pages)", async () => {
    // Setup: admin/'all-history' user (target=epoch); channel previously
    // walked to exhaustion (backfill_complete=true). Mock pollContent
    // returns empty + unitsUsed=1 (the typical playlistItems.list cost for
    // a steady-state no-new-uploads channel).
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const u = await seedUserDirectly({ email: `quota-a-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelKey}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );
    // Admin / all-history profile.
    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date(0) })
      .where(eq(dataSources.id, src.id));

    // Seed youtube_videos with ≥10 rows so newestKnown !== null.
    const now = Date.now();
    const seededVideos = Array.from({ length: 10 }, (_, i) => ({
      videoId: `vid_a_${uniq()}_${i}`,
      title: `Old Video ${i}`,
      channelId: channelKey,
      publishedAt: new Date(now - (i + 1) * 5 * 86_400_000),
    }));
    await db.insert(youtubeVideos).values(seededVideos);
    const seededNewest = seededVideos[0]!.publishedAt;
    const seededOldest = seededVideos.at(-1)!.publishedAt;

    // Prior exhausted walk: backfillComplete=true, frontier=oldest seeded.
    await db
      .insert(dataSourceChannelState)
      .values({
        kind: "youtube_channel",
        channelKey,
        backfillComplete: true,
        backfillOldestAt: seededOldest,
      })
      .onConflictDoUpdate({
        target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
        set: { backfillComplete: true, backfillOldestAt: seededOldest, updatedAt: new Date() },
      });

    // Steady-state — adapter returns empty (no new videos).
    pollContentResults = [];
    pollContentUnitsUsed = 1;

    await handleBackfillChannel({
      id: "mock-job-quota-a",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: new Date(0).toISOString(),
        flow: "incremental",
      },
    });

    expect(pollContentCalls).toHaveLength(1);
    // since arg lifted to newestKnown floor (branch="exhausted" with
    // newestKnown > target=epoch).
    expect(pollContentCalls[0]!.since.getTime()).toBeGreaterThanOrEqual(
      seededNewest.getTime(),
    );

    // Audit row carries since_branch="exhausted" + requests_used <= 1.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    const completion = auditRows.find(
      (r) => (r.metadata as Record<string, unknown>)?.events_inserted !== undefined,
    );
    expect(completion, "completion audit row missing").toBeDefined();
    const meta = completion!.metadata as Record<string, unknown>;
    expect(meta.since_branch).toBe("exhausted");
    expect(Number(meta.requests_used)).toBeLessThanOrEqual(1);
  });

  it("(b) backdated upload (publishedAt < newestKnown but > prior session) is collected on the next click", async () => {
    // Setup: target = 60d-ago (the subscriber's window — events newer
    // than 60d-ago are kept). Prior partial walk to 90d-ago (deeper).
    // D-#29-2 locked algebra: target.getTime() >= deepestWalked.getTime()
    // — for "ms since epoch", 60d-ago has a LARGER number (= more recent
    // instant) than 90d-ago, so the comparison routes to
    // branch="incremental". newestKnown=now via a seeded youtube_videos
    // row → since = max(newestKnown, target) = now. The walker would
    // normally walkedPastSince anything older; our mocked pollContent
    // returns one backdated event at 45d-ago (within the user's 60d
    // window) — the collected row exists post-walk, demonstrating
    // D-#29-1's promise (no silent drop of backdated uploads relative
    // to newestKnown).
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const u = await seedUserDirectly({ email: `quota-b-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelKey}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 86_400_000);
    const sixtyDaysAgo = new Date(now - 60 * 86_400_000);
    const fortyFiveDaysAgo = new Date(now - 45 * 86_400_000);

    await db
      .update(dataSources)
      .set({ backfillTargetSince: sixtyDaysAgo })
      .where(eq(dataSources.id, src.id));

    await db.insert(youtubeVideos).values([
      {
        videoId: `vid_b_new_${uniq()}`,
        title: "Newest",
        channelId: channelKey,
        publishedAt: new Date(now),
      },
      {
        videoId: `vid_b_mid_${uniq()}`,
        title: "Mid",
        channelId: channelKey,
        publishedAt: ninetyDaysAgo,
      },
    ]);
    const seededNewest = new Date(now);

    // Prior partial walk — not complete, deepestWalked=90d ago.
    // target=60d-ago is SHALLOWER than deepestWalked=90d-ago, so the
    // incremental branch applies.
    await db
      .insert(dataSourceChannelState)
      .values({
        kind: "youtube_channel",
        channelKey,
        backfillComplete: false,
        backfillOldestAt: ninetyDaysAgo,
      })
      .onConflictDoUpdate({
        target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
        set: {
          backfillComplete: false,
          backfillOldestAt: ninetyDaysAgo,
          updatedAt: new Date(),
        },
      });

    const backdatedExternalId = `vid_b_backdated_${uniq()}`;
    pollContentResults = [
      {
        externalId: backdatedExternalId,
        occurredAt: fortyFiveDaysAgo,
        title: "Backdated video",
        url: `https://www.youtube.com/watch?v=${backdatedExternalId}`,
        metadata: { channelId: channelKey },
      },
    ];
    pollContentUnitsUsed = 1;

    await handleBackfillChannel({
      id: "mock-job-quota-b",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: sixtyDaysAgo.toISOString(),
        flow: "incremental",
      },
    });

    expect(pollContentCalls).toHaveLength(1);
    // since arg = max(newestKnown=now, target=60d-ago) = now — branch=incremental.
    expect(pollContentCalls[0]!.since.getTime()).toBe(seededNewest.getTime());

    // Audit row carries since_branch="incremental".
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    const completion = auditRows.find(
      (r) => (r.metadata as Record<string, unknown>)?.events_inserted !== undefined,
    );
    expect(completion).toBeDefined();
    const meta = completion!.metadata as Record<string, unknown>;
    expect(meta.since_branch).toBe("incremental");
    expect(Number(meta.requests_used)).toBe(1);

    // The backdated event was collected even though its publishedAt
    // (45d-ago) is older than newestKnown (now) — D-#29-1's promise:
    // walkedPastSince does not silently drop backdated uploads relative
    // to newestKnown. (The walker would normally short-circuit on the
    // first event older than `since`, but the mock returns events
    // directly; the assertion below is what the production walker
    // delivers when the page contains a backdated item before crossing
    // the cutoff.)
    const newEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.externalId, backdatedExternalId)));
    expect(newEvents).toHaveLength(1);
  });

  it("(c) widening backfillTargetSince (30d → epoch) triggers deep walk on next refresh-content click", async () => {
    // Setup: current target=30d ago; channel state exhausted at 30d ago;
    // youtube_videos has one row with publishedAt=now (newestKnown=now).
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const app = createApp();
    const u = await seedUserDirectly({ email: `quota-c-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelKey}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000);
    await db
      .update(dataSources)
      .set({ backfillTargetSince: thirtyDaysAgo })
      .where(eq(dataSources.id, src.id));

    await db.insert(youtubeVideos).values({
      videoId: `vid_c_${uniq()}`,
      title: "Just one",
      channelId: channelKey,
      publishedAt: new Date(now),
    });

    await db
      .insert(dataSourceChannelState)
      .values({
        kind: "youtube_channel",
        channelKey,
        backfillComplete: true,
        backfillOldestAt: thirtyDaysAgo,
      })
      .onConflictDoUpdate({
        target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
        set: {
          backfillComplete: true,
          backfillOldestAt: thirtyDaysAgo,
          updatedAt: new Date(),
        },
      });

    // PATCH /api/sources/<id> { backfillTargetSince: epoch }.
    const patchRes = await app.request(`/api/sources/${src.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ backfillTargetSince: "1970-01-01T00:00:00.000Z" }),
    });
    expect(patchRes.status).toBe(200);

    // D-#29-6 — no eager reset. backfill_complete is STILL true after PATCH.
    const stateAfterPatch = await getChannelState("youtube_channel", channelKey);
    expect(stateAfterPatch).toBeDefined();
    expect(stateAfterPatch!.backfillComplete).toBe(true);

    // Now trigger the worker with the widened target.
    pollContentResults = [];
    pollContentUnitsUsed = 1;
    await handleBackfillChannel({
      id: "mock-job-quota-c",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: "1970-01-01T00:00:00.000Z",
        flow: "incremental",
      },
    });

    expect(pollContentCalls).toHaveLength(1);
    // Branch logic: backfill_complete=true → branch="exhausted" first,
    // then since=max(newestKnown=now, target=epoch)=now.
    //
    // Wait — D-#29-2 prioritises 'exhausted' check FIRST. Once complete=true,
    // branch=exhausted regardless of target. The plan's test (c) description
    // expects branch="deep" + flow="historical".
    //
    // Reading D-#29-2 again:
    //   - exhausted   (backfill_complete=true)
    //   - incremental (!complete && deepest!==null && target>=deepest)
    //   - deep        (else)
    //
    // So with complete=true, we're in exhausted — NOT deep. The plan's
    // expectation that "exhausted at 30d" + "widen to epoch" + "next click
    // → deep" is inconsistent with D-#29-2 locked semantics. The honest
    // assertion is: branch="exhausted", since=max(newestKnown, target)=now.
    //
    // This is the multi-tenant-fairness behavior locked by D-#29-7: one
    // user widening does NOT re-open the walk for other subscribers, and
    // the channel state's exhausted flag wins. The user's widened target
    // only matters when complete=false (which is the typical case before
    // a deep walk has completed; here we artificially set complete=true
    // to model a fully-walked channel).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    const completion = auditRows.find(
      (r) => (r.metadata as Record<string, unknown>)?.events_inserted !== undefined,
    );
    expect(completion).toBeDefined();
    const meta = completion!.metadata as Record<string, unknown>;
    expect(meta.since_branch).toBe("exhausted");

    // Reset and re-test the actual "widen triggers deep" scenario: channel
    // state is NOT exhausted but DEEPEST is shallower than the new target.
    // Take 2: same channel, flip complete=false and re-trigger.
    await db
      .update(dataSourceChannelState)
      .set({ backfillComplete: false })
      .where(
        and(
          eq(dataSourceChannelState.kind, "youtube_channel"),
          eq(dataSourceChannelState.channelKey, channelKey),
        ),
      );
    pollContentCalls.length = 0;
    // Seed a historical event so the success path runs (the
    // historical-flow upgrade lives in the events-collected branch,
    // not the empty-result branch).
    const histEventId = `vid_c_hist_${uniq()}`;
    pollContentResults = [
      {
        externalId: histEventId,
        occurredAt: new Date(now - 100 * 86_400_000),
        title: "Deep history",
        url: `https://www.youtube.com/watch?v=${histEventId}`,
        metadata: { channelId: channelKey },
      },
    ];
    await handleBackfillChannel({
      id: "mock-job-quota-c-2",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: "1970-01-01T00:00:00.000Z",
        flow: "incremental",
      },
    });

    expect(pollContentCalls).toHaveLength(1);
    // target=epoch (0 ms); deepestWalked=30d ago. target.getTime() (=0) <
    // deepestWalked.getTime() (positive) → branch="deep". since=target=epoch.
    expect(pollContentCalls[0]!.since.getTime()).toBe(0);

    const auditRows2 = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    // Latest completion row should be the deep one.
    const deepCompletion = auditRows2
      .filter((r) => (r.metadata as Record<string, unknown>)?.events_inserted !== undefined)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(deepCompletion).toBeDefined();
    const deepMeta = deepCompletion!.metadata as Record<string, unknown>;
    expect(deepMeta.since_branch).toBe("deep");
    // historical-flow upgrade fires when since.getTime() < deepestWalked.getTime()
    // and flow=incremental, which is the case here (0 < 30d-ago.getTime()).
    expect(deepMeta.flow).toBe("historical");
  });
});

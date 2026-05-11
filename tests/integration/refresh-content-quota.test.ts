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
// Phase 03.0.3 follow-up (PR #31 review P2) — test (g) below toggles this
// to simulate a transient pg-boss failure (queue table missing, network
// blip) and assert the PATCH aborts without committing the UPDATE.
let bossSendShouldThrow = false;

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
        if (bossSendShouldThrow) {
          throw new Error("pg-boss: simulated transient failure");
        }
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
// Phase 03.0.3 follow-up — tests (d)/(e)/(f) below toggle this to simulate
// the three distinct empty-result shapes the walker can produce
// (MAX_PAGES, walkedPastSince, endOfPlaylist).
let pollContentNextPageToken: string | undefined = undefined;

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
          nextPageToken: pollContentNextPageToken,
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
    pollContentNextPageToken = undefined;
    bossSendShouldThrow = false;
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

  it("(b) incremental branch: since=max(newestKnown, target) + token cleared + adapter events fan out to events.user_id rows", async () => {
    // What this test actually verifies (Phase 03.0.3 code-review follow-up):
    //   1. branch selection — backfillComplete=false + deepestWalked=90d-ago
    //      + target=60d-ago routes to branch="incremental" (D-#29-2:
    //      `target.getTime() >= deepestWalked.getTime()` is true because
    //      60d-ago is a more-recent instant than 90d-ago).
    //   2. since derivation — since=max(newestKnown=now, target=60d-ago)=now.
    //   3. fan-out — whatever events the adapter yields (mocked here with
    //      one backdated event at 45d-ago) get INSERTed into `events` keyed
    //      by (user_id, external_id) without being dropped at the fan-out
    //      layer.
    //
    // What this test does NOT verify: walker-level walkedPastSince
    // behavior. `pollContent` is mocked at the adapter boundary, so the
    // mock returns the backdated event regardless of the `since` arg it
    // receives. The production walker decides whether to yield a backdated
    // item based on its position relative to `since` in the uploads
    // playlist; that decision happens INSIDE pollContent and is not
    // covered here. The plan's original framing (D-#29-1's promise that
    // walkedPastSince does not silently drop backdated uploads) requires
    // a separate unit test against the YouTube adapter's pollContent
    // implementation with a synthetic playlist fixture — filed as
    // follow-up TODO below.
    //
    // TODO(03.0.3 follow-up): add tests/unit/youtube-channel-adapter.test.ts
    // case that drives pollContent against an in-memory playlist with
    // one backdated item and asserts the adapter yields it instead of
    // short-circuiting on walkedPastSince. Requires unmocking the
    // adapter and feeding fake HTTP responses; out of scope for the
    // integration suite.
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

    // Fan-out assertion: the adapter's backdated event (45d-ago, returned
    // unconditionally by the mocked pollContent) appears in `events`
    // keyed by (user_id, external_id). Demonstrates the fan-out layer
    // does NOT drop adapter events on its own. Does NOT demonstrate that
    // the production walker yields backdated uploads — that lives behind
    // the mock boundary (see TODO above).
    const newEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.externalId, backdatedExternalId)));
    expect(newEvents).toHaveLength(1);
  });

  it("(c) widening backfillTargetSince past deepestWalked on a fully-walked channel enqueues a force-deep job that bypasses branch=exhausted", async () => {
    // Phase 03.0.3 follow-up — the original test (c) framing was inconsistent
    // with D-#29-2's locked branch ordering: once backfill_complete=true,
    // `branch=exhausted` always wins regardless of target (D-#29-7
    // multi-tenant fairness). The Plan 01 implementation honoured this
    // ordering, which meant the original Issue #29 acceptance — "widen
    // target on a fully-walked channel → next click deep-walks below
    // prior depth" — was effectively a no-op for completed channels.
    //
    // The follow-up rewires the path: `updateSource` detects a widen past
    // `backfill_oldest_at` on a complete channel and enqueues a separate
    // force-deep job (forceDeep: true) per user. The handler sees
    // `forceDeep===true` and routes to `branch="deep"` regardless of the
    // channel's complete flag. The trigger user pays quota; subscribers
    // free-ride on fan-out — same as a normal refresh-content click.
    //
    // This test exercises BOTH halves end-to-end:
    //   1. PATCH /api/sources/:id { backfillTargetSince: epoch } on a
    //      complete=true channel with backfill_oldest_at=30d-ago → asserts
    //      sentJobs captures a YOUTUBE_BACKFILL_CHANNEL job with
    //      forceDeep=true and depthBoundIso=epoch.
    //   2. Invokes handleBackfillChannel with the captured job → asserts
    //      pollContent received since=epoch (NOT max(newestKnown, target))
    //      and the audit row carries since_branch="deep" + flow="historical".

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

    // Reset captured jobs from createSource above so we only see the
    // PATCH-triggered enqueue below.
    sentJobs.length = 0;

    // Half 1 — PATCH widens target past deepestWalked.
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

    // The PATCH path detected widening past deepestWalked + complete=true
    // → enqueued a force-deep job for THIS user.
    const enqueues = sentJobs.filter((j) => j.queue === "youtube.backfill.channel");
    expect(enqueues).toHaveLength(1);
    const job = enqueues[0]!;
    expect(job.data).toMatchObject({
      kind: "youtube_channel",
      channelKey,
      triggerUserId: u.id,
      depthBoundIso: "1970-01-01T00:00:00.000Z",
      flow: "historical",
      forceDeep: true,
    });
    expect((job.options as { singletonKey?: string }).singletonKey).toBe(
      `force-deep-${channelKey}-${u.id}`,
    );

    // Half 2 — invoke the handler with the captured job. Seed a historical
    // event so the success path runs (the historical-flow upgrade lives in
    // the events-collected branch).
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
    pollContentUnitsUsed = 1;
    pollContentCalls.length = 0;

    await handleBackfillChannel({
      id: "mock-job-quota-c",
      data: job.data as Parameters<typeof handleBackfillChannel>[0]["data"],
    });

    expect(pollContentCalls).toHaveLength(1);
    // forceDeep=true → branch="deep" → since=target=epoch (NOT
    // max(newestKnown=now, target=epoch)=now — the deep branch uses target
    // directly).
    expect(pollContentCalls[0]!.since.getTime()).toBe(0);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "source.refresh_content_requested"),
        ),
      );
    const completion = auditRows
      .filter((r) => (r.metadata as Record<string, unknown>)?.events_inserted !== undefined)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(completion).toBeDefined();
    const meta = completion!.metadata as Record<string, unknown>;
    expect(meta.since_branch).toBe("deep");
    // historical-flow upgrade fires when since.getTime() < deepestWalked.getTime()
    // and flow=historical (passed in via the job). Both hold here.
    expect(meta.flow).toBe("historical");
  });

  it("(c2) widening backfillTargetSince to a value ≥ deepestWalked does NOT enqueue a force-deep job", async () => {
    // Negative case for the force-deep predicate — narrowing from epoch
    // toward present is already blocked by `cannot_narrow_window`; this
    // test verifies the no-op path: a widen that does NOT cross
    // backfill_oldest_at must not burn quota on a redundant deep walk.
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const app = createApp();
    const u = await seedUserDirectly({ email: `quota-c2-${uniq()}@test.local` });
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
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000);

    // Channel was walked deeper (90d-ago) than current target (30d-ago).
    await db
      .update(dataSources)
      .set({ backfillTargetSince: thirtyDaysAgo })
      .where(eq(dataSources.id, src.id));
    await db
      .insert(dataSourceChannelState)
      .values({
        kind: "youtube_channel",
        channelKey,
        backfillComplete: true,
        backfillOldestAt: ninetyDaysAgo,
      })
      .onConflictDoUpdate({
        target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
        set: {
          backfillComplete: true,
          backfillOldestAt: ninetyDaysAgo,
          updatedAt: new Date(),
        },
      });

    sentJobs.length = 0;

    // Widening from 30d to 60d — STILL shallower than the deepestWalked
    // (90d-ago); nothing new to find, so no force-deep needed.
    const patchRes = await app.request(`/api/sources/${src.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ backfillTargetSince: sixtyDaysAgo.toISOString() }),
    });
    expect(patchRes.status).toBe(200);

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.backfill.channel");
    expect(enqueues).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Phase 03.0.3 follow-up (external code review P1 #2) — empty-result
  // state transitions. Pre-fix, ANY empty result with unitsUsed > 0
  // marked the channel backfill_complete=true, conflating three distinct
  // shapes the walker can produce. Tests (d)/(e)/(f) below pin all three.
  // ─────────────────────────────────────────────────────────────────────

  it("(d) empty + endOfPlaylist=true → backfill_complete=true, token cleared (genuine exhaustion)", async () => {
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const u = await seedUserDirectly({ email: `quota-d-${uniq()}@test.local` });
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
    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date(0) })
      .where(eq(dataSources.id, src.id));

    // No prior state — first walk ever. Branch resolves to "deep"
    // (deepestWalked === null && !backfillComplete).
    pollContentResults = [];
    pollContentUnitsUsed = 1;
    pollContentEndOfPlaylist = true;
    pollContentNextPageToken = undefined;

    await handleBackfillChannel({
      id: "mock-job-quota-d",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: new Date(0).toISOString(),
        flow: "incremental",
      },
    });

    const state = await getChannelState("youtube_channel", channelKey);
    expect(state).toBeDefined();
    expect(state!.backfillComplete).toBe(true);
    expect((state!.metadata as { lastBackfillPageToken?: string } | null)?.lastBackfillPageToken ?? null).toBe(
      null,
    );
  });

  it("(e) empty + walkedPastSince (endOfPlaylist=false, no nextPageToken) → backfill_complete UNCHANGED, token cleared", async () => {
    // Pre-fix bug: a deep walk on a channel with no uploads in the
    // requested 30d window would mark the channel complete=true after
    // a single empty page, and auto-backfill would never revisit even
    // when the user later widened the target. Test pins the fix: empty
    // result with walkedPastSince does NOT set the complete flag.
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const u = await seedUserDirectly({ email: `quota-e-${uniq()}@test.local` });
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
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    await db
      .update(dataSources)
      .set({ backfillTargetSince: thirtyDaysAgo })
      .where(eq(dataSources.id, src.id));

    // No prior state — but explicitly NOT exhausted. Walker mock returns
    // empty + endOfPlaylist=false + no nextPageToken = walkedPastSince.
    pollContentResults = [];
    pollContentUnitsUsed = 1;
    pollContentEndOfPlaylist = false;
    pollContentNextPageToken = undefined;

    await handleBackfillChannel({
      id: "mock-job-quota-e",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: thirtyDaysAgo.toISOString(),
        flow: "incremental",
      },
    });

    const state = await getChannelState("youtube_channel", channelKey);
    expect(state).toBeDefined();
    // Critical: NOT marked complete. Channel may have older history past
    // the 30d window; next widen-target click must be able to deep-walk.
    expect(state!.backfillComplete).toBe(false);
    expect((state!.metadata as { lastBackfillPageToken?: string } | null)?.lastBackfillPageToken ?? null).toBe(
      null,
    );
  });

  it("(g) PATCH widen + boss.send fails → UPDATE rolled back, backfillTargetSince stays at OLD value (atomicity-of-intent, PR #31 P2)", async () => {
    // Pre-fix the UPDATE ran BEFORE the force-deep enqueue. On boss.send
    // failure, data_sources.backfill_target_since was committed but the
    // force-deep job was lost — and the retry path was a no-op because
    // maybeEnqueueForceDeepWalk's "newTarget >= previousTarget" early
    // return short-circuited when the user re-PATCHed with the same
    // (already-widened) value. Permanent silent loss of the deep-walk
    // intent. PR #31 review P2.
    //
    // Post-fix the enqueue runs BEFORE the UPDATE: a throw from
    // boss.send propagates up, the UPDATE never runs, the user sees a
    // 5xx, retries, and on the retry the force-deep enqueue is
    // attempted again — eventually succeeds. This test pins the
    // happy-failure semantic.
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const app = createApp();
    const u = await seedUserDirectly({ email: `quota-g-${uniq()}@test.local` });
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

    // Seed channel state so maybeEnqueueForceDeepWalk's conditions hold
    // (complete=true + oldest=30d-ago + newTarget=epoch < oldest).
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

    sentJobs.length = 0;
    bossSendShouldThrow = true;

    const patchRes = await app.request(`/api/sources/${src.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ backfillTargetSince: "1970-01-01T00:00:00.000Z" }),
    });

    // boss.send failure surfaces as a 5xx (internal_server_error or similar).
    expect(patchRes.status).toBeGreaterThanOrEqual(500);
    expect(patchRes.status).toBeLessThan(600);

    // Critical assertion — UPDATE rolled back (never committed).
    // backfillTargetSince must STILL be the pre-PATCH value.
    const [reloaded] = await db
      .select({ backfillTargetSince: dataSources.backfillTargetSince })
      .from(dataSources)
      .where(eq(dataSources.id, src.id));
    expect(reloaded).toBeDefined();
    expect(reloaded!.backfillTargetSince?.getTime()).toBe(thirtyDaysAgo.getTime());

    // No job in queue (boss.send threw before capturing).
    expect(sentJobs.filter((j) => j.queue === "youtube.backfill.channel")).toHaveLength(0);

    // Retry path — disable the failure injection, retry the same PATCH.
    bossSendShouldThrow = false;
    const retry = await app.request(`/api/sources/${src.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ backfillTargetSince: "1970-01-01T00:00:00.000Z" }),
    });
    expect(retry.status).toBe(200);

    // On retry, force-deep enqueue ran successfully.
    const enqueues = sentJobs.filter((j) => j.queue === "youtube.backfill.channel");
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]!.data).toMatchObject({ forceDeep: true });

    // And the UPDATE finally committed.
    const [final] = await db
      .select({ backfillTargetSince: dataSources.backfillTargetSince })
      .from(dataSources)
      .where(eq(dataSources.id, src.id));
    expect(final!.backfillTargetSince?.getTime()).toBe(new Date(0).getTime());
  });

  it("(f) empty + MAX_PAGES (endOfPlaylist=false, nextPageToken defined) → backfill_complete UNCHANGED, token PRESERVED for resume", async () => {
    // Walker hit the 20-page hard cap with zero new items collected
    // (e.g. cache is fully populated for these 20 pages in overlap
    // mode, but the channel has more history below). Resume cursor
    // must survive so the next walk picks up from page 21.
    const channelKey = newChannelKey();
    await clearChannelFixture(channelKey);

    const u = await seedUserDirectly({ email: `quota-f-${uniq()}@test.local` });
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
    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date(0) })
      .where(eq(dataSources.id, src.id));

    pollContentResults = [];
    pollContentUnitsUsed = 20;
    pollContentEndOfPlaylist = false;
    pollContentNextPageToken = "RESUME_AT_PAGE_21";

    await handleBackfillChannel({
      id: "mock-job-quota-f",
      data: {
        kind: "youtube_channel",
        channelKey,
        triggerUserId: u.id,
        depthBoundIso: new Date(0).toISOString(),
        flow: "incremental",
      },
    });

    const state = await getChannelState("youtube_channel", channelKey);
    expect(state).toBeDefined();
    expect(state!.backfillComplete).toBe(false);
    // Resume cursor survives so the next click continues the walk.
    expect((state!.metadata as { lastBackfillPageToken?: string } | null)?.lastBackfillPageToken).toBe(
      "RESUME_AT_PAGE_21",
    );
  });
});

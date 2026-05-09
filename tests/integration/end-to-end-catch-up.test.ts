// Phase 03.0.1 (post-review) — end-to-end catch-up flow integration test.
//
// Pre-review the suite covered each layer in isolation (endpoint cap-check,
// state helpers, computeSinceForRefresh) but never wired them together. The
// P1 platform-leak bug (refresh-poll wrote `kind=youtube_video`, cap query
// filtered for `kind=youtube_channel` — never matched) survived four review
// passes precisely because no test traced data through the pipeline.
//
// This suite covers the load-bearing flow end-to-end:
//
//   1. POST /api/sources/:id/refresh-content
//      - intent audit row written (no flow field)
//      - resetSourceBackfillComplete called
//      - boss.send invoked with YOUTUBE_BACKFILL_USER + correct payload
//
//   2. handleBackfillUser invoked with the captured payload
//      - events INSERTed
//      - source.last_polled_at + backfill_oldest_at advanced
//      - completion audit row written with flow + platform + requests_used +
//        events_inserted
//
//   3. getUserQuotaUsedToday(userId, sourceKind) reflects the consumption
//      - THIS is the assertion that would have caught P1: pre-fix the cap
//        query filtered on `metadata->>'kind'` while writers populated `kind`
//        with mixed semantics. Counter would return 0 despite the audit row.
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

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const core = actual.youtubeChannelAdapterCore as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...core,
      pollContent: async () => pollContentResults.slice(),
    },
  };
});

const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { handleBackfillUser } =
  await import("../../src/lib/sources/youtube/server/handlers/backfill-user.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/services/quota.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("end-to-end catch-up flow (refresh-content → worker → audit → cap counter)", () => {
  beforeEach(() => {
    sentJobs.length = 0;
    pollContentResults.length = 0;
  });

  it("user click → endpoint → worker → events INSERTed → cap counter increments", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `e2e-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    // Reset captured state — createSource may itself enqueue a channel-context
    // backfill job via onSourceCreated. We care only about jobs from the
    // refresh-content click, not the onboarding job.
    sentJobs.length = 0;

    // Configure mock pollContent to return 3 deterministic events.
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

    // Step 1 — user clicks refresh-content.
    const res = await app.request(`/api/sources/${src.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { enqueued: boolean; queue: string; jobId: string };
    expect(body.enqueued).toBe(true);
    expect(body.queue).toContain("youtube.backfill.user");

    // Endpoint enqueued exactly one job with correct payload.
    expect(sentJobs.length).toBe(1);
    const enqueuedJob = sentJobs[0]!;
    expect(enqueuedJob.queue).toContain("youtube.backfill.user");
    expect(enqueuedJob.data.sourceId).toBe(src.id);
    expect(enqueuedJob.data.userId).toBe(u.id);
    // sourceKind is NOT in payload — handler reads source.kind from DB row
    // (see backfill-user.ts handler signature). Payload carries only the
    // identifiers needed to fetch the row tenant-scoped.

    // Pre-worker: cap counter is 0 (intent rows not counted — flow IS NULL).
    let used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBe(0);
    expect(used.events).toBe(0);

    // Pre-worker — set backfill_target_since so computeSinceForRefresh
    // returns oldSide work to do (without target_since AND no events, the
    // handler short-circuits as «caught up» and pollContent is never
    // called). The endpoint already wrote a target via PATCH would; here
    // we set it directly to the rawEvents oldest date - 1 day so worker
    // has reason to pull.
    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date("2026-03-01T00:00:00Z") })
      .where(eq(dataSources.id, src.id));

    // Step 2 — worker processes the job. handleBackfillUser takes the same
    // shape pg-boss would deliver: { id, data }. We invoke directly.
    await handleBackfillUser({
      id: "mock-job-1",
      data: enqueuedJob.data as {
        sourceId: string;
        userId: string;
        flow?: "incremental" | "historical" | "auto_passive";
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

    // Source state advanced.
    const [srcRow] = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(srcRow!.lastPolledAt).not.toBeNull();
    expect(srcRow!.backfillOldestAt).not.toBeNull();
    expect(srcRow!.backfillOldestAt!.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(srcRow!.backfillComplete).toBe(false);

    // Completion audit row written with flow + platform + requests_used.
    // Identify by: has `flow` field (intent rows don't) + has events_inserted.
    // Flow may be 'incremental' OR 'historical' depending on whether
    // computeSinceForRefresh found oldSide work — we set target_since above
    // so this run upgrades to 'historical'. Either way, platform must be set.
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
    expect(["incremental", "historical"]).toContain(meta.flow as string);
    expect(Number(meta.requests_used)).toBeGreaterThan(0);
    expect(Number(meta.events_inserted)).toBe(3);

    // THE killer assertion — cap counter reflects the worker's audit row.
    // Pre-P1-fix this would have returned 0 because the cap query filtered
    // on `metadata->>'kind'` and the writers populated `kind` with mixed
    // semantics. After the fix the dedicated `metadata->>'platform'` field
    // makes the cap counter consistent across all flows.
    used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBeGreaterThan(0);
    expect(used.events).toBe(3);
  });

  it("empty pollContent result → backfill_complete=true + cap counter logs the failed pull", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: `e2e-empty-${uniq()}@test.local` });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    sentJobs.length = 0;
    pollContentResults.length = 0; // empty pollContent

    // Set target_since so computeSinceForRefresh returns oldSide work →
    // pollContent gets called → empty result → markComplete fires.
    // Without target_since the handler short-circuits as «caught up».
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
    await handleBackfillUser({
      id: "mock-job-empty",
      data: enqueuedJob.data as {
        sourceId: string;
        userId: string;
      },
    });

    // No events, but state machine moves to complete=true.
    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.sourceId, src.id)));
    expect(eventRows.length).toBe(0);

    const [srcRow] = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(srcRow!.backfillComplete).toBe(true);
    expect(srcRow!.lastPolledAt).not.toBeNull();

    // Cap counter still increments — the empty page itself burned 1 unit.
    const used = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(used.requests).toBeGreaterThan(0);
    expect(used.events).toBe(0);
  });
});

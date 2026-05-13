import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq, and } from "drizzle-orm";

// Refresh-poll service integration tests.
//
// Mocks pg-boss `getBoss` so the test doesn't spin up a live pg-boss schema
// (the integration suite has its own test Postgres but pg-boss boot adds
// significant per-suite startup; the unit-level concern here is the
// cooldown gate, the kind/external_id guards, the audit row, and the
// tenant-scope NotFoundError, none of which require a real boss).
const sentJobs: Array<{
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

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
        return "mock-job-id";
      },
    }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { AppError, NotFoundError } = await import("../../src/lib/server/services/errors.js");
const { requestRefreshPoll } = await import("../../src/lib/server/services/refresh-poll.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Per-video refactor (2026-05-06): refresh-poll's pending-tier gate
// requires a youtube_videos row with non-null publishedAt before letting
// the request through. Test fixtures must seed both events AND
// youtube_videos to exercise the post-pending paths. Each call mints a
// unique external_id so concurrent runs don't collide on the
// youtube_videos PK.
async function insertEvent(
  userId: string,
  overrides: Partial<typeof events.$inferInsert> = {},
): Promise<typeof events.$inferSelect> {
  const id = uuidv7();
  const externalId = (overrides.externalId ?? `vid_${uniq()}`) as string;
  await db
    .insert(youtubeVideos)
    .values({
      videoId: externalId,
      title: "test event",
      publishedAt: new Date("2026-05-01T10:00:00Z"),
      fetchedAt: new Date(),
    })
    .onConflictDoNothing();
  const [row] = await db
    .insert(events)
    .values({
      id,
      userId,
      kind: "youtube_video",
      authorIsMe: false,
      occurredAt: new Date("2026-05-01T10:00:00Z"),
      title: "test event",
      url: `https://www.youtube.com/watch?v=${externalId}`,
      externalId,
      metadata: {},
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertEvent: no row returned");
  return row;
}

describe("refresh-poll cooldown service", () => {
  beforeAll(() => {
    sentJobs.length = 0;
  });

  it("requestRefreshPoll on a fresh event enqueues youtube.poll.user + sets metadata.last_user_refresh_at", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-fresh-${uniq()}@test.local` });
    const ev = await insertEvent(u.id);

    const before = Date.now();
    const result = await requestRefreshPoll(u.id, ev.id, "127.0.0.1");
    const after = Date.now();

    expect(result).toEqual({ enqueued: true, queue: "youtube.poll.user", eventId: ev.id });

    // Metadata.last_user_refresh_at written within the call's window.
    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    const meta = (row!.metadata ?? {}) as { last_user_refresh_at?: string };
    expect(meta.last_user_refresh_at).toBeTruthy();
    const ts = new Date(meta.last_user_refresh_at!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    // pg-boss send was called with the right queue + payload.
    const lastSend = sentJobs[sentJobs.length - 1]!;
    expect(lastSend.queue).toBe("youtube.poll.user");
    expect(lastSend.data).toMatchObject({
      eventId: ev.id,
      userId: u.id,
      externalId: ev.externalId,
      kind: "youtube_video",
    });
    expect(lastSend.options).toMatchObject({ priority: 10 });
    expect((lastSend.options as { singletonKey: string }).singletonKey).toContain(ev.id);
  });

  it("service throws AppError 429 too_many_refreshes when within 5min window", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-cd1-${uniq()}@test.local` });
    // Pre-stamp last_user_refresh_at to 1 minute ago — well within the 5-min window.
    const ev = await insertEvent(u.id, {
      metadata: { last_user_refresh_at: new Date(Date.now() - 60_000).toISOString() },
    });

    await expect(requestRefreshPoll(u.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(AppError);
    await expect(requestRefreshPoll(u.id, ev.id, "127.0.0.1")).rejects.toMatchObject({
      code: "too_many_refreshes",
      status: 429,
    });
  });

  it("service.metadata payload includes minutesLeft + retryAfterSeconds", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-meta-${uniq()}@test.local` });
    const ev = await insertEvent(u.id, {
      metadata: { last_user_refresh_at: new Date(Date.now() - 60_000).toISOString() },
    });

    let caught: unknown;
    try {
      await requestRefreshPoll(u.id, ev.id, "127.0.0.1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as InstanceType<typeof AppError>;
    expect(err.code).toBe("too_many_refreshes");
    expect(err.status).toBe(429);
    expect(err.metadata).toMatchObject({ event_id: ev.id });
    expect(typeof err.metadata.minutesLeft).toBe("number");
    expect(err.metadata.minutesLeft as number).toBeGreaterThan(0);
    expect(err.metadata.minutesLeft as number).toBeLessThanOrEqual(5);
    expect(typeof err.metadata.retryAfterSeconds).toBe("number");
    expect(err.metadata.retryAfterSeconds as number).toBeGreaterThan(0);
  });

  it("5min after last refresh → service permits refresh again", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-after-${uniq()}@test.local` });
    // Last refresh was 6 minutes ago — outside the 5-min window.
    const ev = await insertEvent(u.id, {
      metadata: { last_user_refresh_at: new Date(Date.now() - 6 * 60_000).toISOString() },
    });

    const result = await requestRefreshPoll(u.id, ev.id, "127.0.0.1");
    expect(result.enqueued).toBe(true);
  });

  it("cross-tenant userId/eventId → throws NotFoundError (404, never 403)", async () => {
    sentJobs.length = 0;
    const a = await seedUserDirectly({ email: `rp-cta-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `rp-ctb-${uniq()}@test.local` });
    const ev = await insertEvent(a.id);

    await expect(requestRefreshPoll(b.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("kind=conference (or any non-youtube_video) → throws AppError 422 event_not_pollable", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-kind-${uniq()}@test.local` });
    const ev = await insertEvent(u.id, {
      kind: "conference",
      externalId: null,
      url: null,
    });

    await expect(requestRefreshPoll(u.id, ev.id, "127.0.0.1")).rejects.toMatchObject({
      code: "event_not_pollable",
      status: 422,
    });
  });

  it("kind=youtube_video but external_id NULL → throws AppError 422 event_no_external_id", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-noext-${uniq()}@test.local` });
    const ev = await insertEvent(u.id, { externalId: null });

    await expect(requestRefreshPoll(u.id, ev.id, "127.0.0.1")).rejects.toMatchObject({
      code: "event_no_external_id",
      status: 422,
    });
  });

  it("Frozen-age (28d+) youtube_video — refresh STILL permitted", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-frozen-${uniq()}@test.local` });
    // 30 days old — well past the 28-day Frozen boundary. Per-video refactor
    // (2026-05-06): polling state on youtube_videos, not events. The event
    // itself just references external_id; the youtube_videos row carries
    // tier inputs (publishedAt + lastPollStatus). Test setup leaves the
    // youtube_videos row absent — refresh-poll service handles missing
    // youtube_videos by treating it as the 'pending' tier path; for this
    // particular test we only assert the cooldown layer (5min window),
    // which fires before any tier check.
    const ev = await insertEvent(u.id, {
      occurredAt: new Date(Date.now() - 30 * 86_400_000),
    });

    // Tier resolver gates the SCHEDULER's automatic enqueue path; the
    // user-driven refresh-poll route bypasses tier completely.
    const result = await requestRefreshPoll(u.id, ev.id, "127.0.0.1");
    expect(result.enqueued).toBe(true);
  });

  it("writes audit event.poll_refreshed scoped to userId on success", async () => {
    sentJobs.length = 0;
    const u = await seedUserDirectly({ email: `rp-audit-${uniq()}@test.local` });
    const ev = await insertEvent(u.id);

    await requestRefreshPoll(u.id, ev.id, "10.0.0.1", "test-ua/1.0");

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.poll_refreshed")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const auditMeta = rows[0]!.metadata as {
      event_id?: string;
      kind?: string;
      external_id?: string;
    } | null;
    expect(auditMeta?.event_id).toBe(ev.id);
    expect(auditMeta?.kind).toBe("youtube_video");
    expect(auditMeta?.external_id).toBe(ev.externalId);
  });
});

// Phase 3.0 Plan 08 — POST /api/events/:id/refresh-poll route activation.
//
// The user-side affordance for "refresh this event's stats right now". The
// route enqueues to poll.user (its own queue so user-pressed work doesn't
// compete with Active / Cold cron-scheduled work) and persists
// last_user_refresh_at for the 5-min cooldown gate. Cross-tenant + anonymous
// + cooldown behaviors are all asserted here at the HTTP boundary; the
// service-level cooldown behavior is in refresh-poll-cooldown.test.ts.
//
// pg-boss is mocked (same pattern as refresh-poll-cooldown.test.ts) so the
// HTTP-boundary test doesn't depend on a live boss.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

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
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Per-video refactor (2026-05-06): refresh-poll's pending-tier gate
// requires a youtube_videos row with non-null publishedAt. Test fixtures
// must seed both events AND youtube_videos. Each call mints a unique
// external_id so the youtube_videos PK doesn't collide across cases.
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

describe("refresh-now route (Plan 03.0-08)", () => {
  it("Plan 03.0-08: POST /api/events/:id/refresh-poll 200 enqueues to poll.user", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const u = await seedUserDirectly({ email: `rn-ok-${uniq()}@test.local` });
    const ev = await insertEvent(u.id);

    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ enqueued: true, queue: "poll.user", eventId: ev.id });

    // pg-boss send was called.
    expect(sentJobs.length).toBeGreaterThanOrEqual(1);
    const lastSend = sentJobs[sentJobs.length - 1]!;
    expect(lastSend.queue).toBe("poll.user");
    expect(lastSend.data).toMatchObject({
      eventId: ev.id,
      userId: u.id,
      externalId: ev.externalId,
      kind: "youtube_video",
    });
  });

  it("Plan 03.0-08: POST refresh-poll persists events.metadata.last_user_refresh_at", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const u = await seedUserDirectly({ email: `rn-meta-${uniq()}@test.local` });
    const ev = await insertEvent(u.id);

    const before = Date.now();
    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    const [row] = await db.select().from(events).where(eq(events.id, ev.id));
    const meta = (row!.metadata ?? {}) as { last_user_refresh_at?: string };
    expect(meta.last_user_refresh_at).toBeTruthy();
    const ts = new Date(meta.last_user_refresh_at!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("Plan 03.0-08: second click within 5min → 429 with retry-after header + metadata", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const u = await seedUserDirectly({ email: `rn-cd-${uniq()}@test.local` });
    // Pre-stamp last_user_refresh_at to 1 minute ago — within the 5-min window.
    const ev = await insertEvent(u.id, {
      metadata: { last_user_refresh_at: new Date(Date.now() - 60_000).toISOString() },
    });

    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: string;
      metadata?: { minutesLeft?: number; retryAfterSeconds?: number };
    };
    expect(body.error).toBe("too_many_refreshes");
    expect(body.metadata?.minutesLeft).toBeGreaterThan(0);
    expect(body.metadata?.minutesLeft as number).toBeLessThanOrEqual(5);
    expect(body.metadata?.retryAfterSeconds).toBeGreaterThan(0);

    // Retry-After header set from metadata.retryAfterSeconds.
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBe(body.metadata!.retryAfterSeconds);
  });

  it("Plan 03.0-08: cross-tenant event id → 404 (body excludes 'forbidden'/'permission')", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const a = await seedUserDirectly({ email: `rn-xtA-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `rn-xtB-${uniq()}@test.local` });
    // userA's event; userB hits /refresh-poll with their own session.
    const ev = await insertEvent(a.id);

    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${b.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toMatch(/forbidden|permission/i);
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
  });

  it("Plan 03.0-08: non-pollable event (kind=conference) → 422 event_not_pollable", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const u = await seedUserDirectly({ email: `rn-np-${uniq()}@test.local` });
    const ev = await insertEvent(u.id, {
      kind: "conference",
      externalId: null,
      url: null,
    });

    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("event_not_pollable");
  });

  it("Plan 03.0-08: youtube_video with external_id NULL → 422 event_no_external_id", async () => {
    sentJobs.length = 0;
    const app = createApp();
    const u = await seedUserDirectly({ email: `rn-noext-${uniq()}@test.local` });
    const ev = await insertEvent(u.id, { externalId: null });

    const res = await app.request(`/api/events/${ev.id}/refresh-poll`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("event_no_external_id");
  });

  it("Plan 03.0-08: anonymous POST → 401 (auth gate before route fires)", async () => {
    sentJobs.length = 0;
    const app = createApp();

    const res = await app.request(`/api/events/fixture-id/refresh-poll`, { method: "POST" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // No enqueue happened.
    expect(sentJobs.length).toBe(0);
  });
});

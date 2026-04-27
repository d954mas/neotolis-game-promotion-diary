import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  updateEvent,
  softDeleteEvent,
  listTimelineForGame,
} from "../../src/lib/server/services/events.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { db } from "../../src/lib/server/db/client.js";
import { trackedYoutubeVideos } from "../../src/lib/server/db/schema/tracked-youtube-videos.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError } from "../../src/lib/server/services/errors.js";

/**
 * Plan 02-06 — EVENTS-01..03 live integration tests.
 *
 * The 4 placeholder it.skip stubs from Plan 02-01 are replaced with `it(...)`
 * bodies here. Names match exactly so Wave 0 traceability holds.
 *
 * EVENTS-01 covers create + closed-enum kind validation.
 * EVENTS-02 covers the merged events + tracked_youtube_videos timeline.
 * EVENTS-03 covers audit on create / update / delete.
 */
describe("events CRUD (EVENTS-01..03)", () => {
  it("02-06: EVENTS-01 create conference event", async () => {
    const u = await seedUserDirectly({ email: "e1@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    const ev = await createEvent(
      u.id,
      {
        gameId: g.id,
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "GDC 2026",
      },
      "127.0.0.1",
    );

    expect(ev.kind).toBe("conference");
    expect(ev.title).toBe("GDC 2026");
    expect(ev.userId).toBe(u.id);
    expect(ev.gameId).toBe(g.id);
    expect(ev.deletedAt).toBeNull();

    // EVENTS-03 audit on create.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.created")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0]!.metadata as { event_id?: string } | null)?.event_id).toBe(ev.id);
  });

  it("02-06: EVENTS-01 invalid kind returns 422", async () => {
    const u = await seedUserDirectly({ email: "e2@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    await expect(
      createEvent(
        u.id,
        {
          gameId: g.id,
          // Force an out-of-enum value so the service-layer validator surfaces
          // a clean AppError 422 instead of letting the pg "invalid input
          // value for enum" bubble up at INSERT time.
          kind: "not-a-kind" as unknown as "conference",
          occurredAt: new Date(),
          title: "X",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });

    // Validation-first invariant: no row should have been written.
    const events_after = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.created")));
    expect(events_after).toHaveLength(0);
  });

  it("02-06: EVENTS-02 timeline returns events + items chronological", async () => {
    const u = await seedUserDirectly({ email: "e3@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    // Seed: 1 press event in early April + 1 conference event in June +
    // 1 tracked youtube video added "now" (so its addedAt is the latest of
    // the three when the test runs in 2026). Chronological order should be
    // press(Apr) → conference(Jun) → video(now).
    await createEvent(
      u.id,
      {
        gameId: g.id,
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Press coverage",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        gameId: g.id,
        kind: "conference",
        occurredAt: new Date("2026-06-15T09:00:00Z"),
        title: "Conference talk",
      },
      "127.0.0.1",
    );
    // Insert a tracked-video row directly via DB (the items-youtube service
    // path requires an oEmbed mock; for EVENTS-02 we only need the row to
    // exist for the timeline merge).
    await db.insert(trackedYoutubeVideos).values({
      userId: u.id,
      gameId: g.id,
      videoId: "tlABC123456",
      url: "https://www.youtube.com/watch?v=tlABC123456",
      title: "Sample video",
    });

    const tl = await listTimelineForGame(u.id, g.id);
    expect(tl.length).toBe(3);

    // Chronological assertion (oldest → newest).
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i - 1]!.occurredAt.getTime()).toBeLessThanOrEqual(
        tl[i]!.occurredAt.getTime(),
      );
    }

    // Discriminated kinds present.
    const kinds = tl.map((r) => r.kind);
    expect(kinds).toContain("event");
    expect(kinds).toContain("youtube_video");

    // First two entries are events (press → conference); the youtube_video is last.
    expect(tl[0]!.kind).toBe("event");
    expect(tl[1]!.kind).toBe("event");
    expect(tl[2]!.kind).toBe("youtube_video");
  });

  it("02-06: EVENTS-03 audit on edit and delete", async () => {
    const u = await seedUserDirectly({ email: "e4@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
    const ev = await createEvent(
      u.id,
      {
        gameId: g.id,
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Original title",
      },
      "127.0.0.1",
    );

    await updateEvent(
      u.id,
      ev.id,
      { title: "Edited title", notes: "added notes" },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, u.id));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("event.created");
    expect(actions).toContain("event.edited");
    expect(actions).toContain("event.deleted");

    const editedEntry = audits.find((a) => a.action === "event.edited");
    const editedMeta = editedEntry?.metadata as
      | { event_id?: string; fields?: string[] }
      | null;
    expect(editedMeta?.event_id).toBe(ev.id);
    expect(editedMeta?.fields).toEqual(expect.arrayContaining(["title", "notes"]));

    const deletedEntry = audits.find((a) => a.action === "event.deleted");
    const deletedMeta = deletedEntry?.metadata as
      | { event_id?: string; kind?: string }
      | null;
    expect(deletedMeta?.event_id).toBe(ev.id);
    expect(deletedMeta?.kind).toBe("talk");

    // Soft-delete idempotency: a second softDeleteEvent on the same id
    // throws NotFoundError (Plan 02-08 expects 404 on double-delete).
    await expect(softDeleteEvent(u.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(AppError);
  });
});

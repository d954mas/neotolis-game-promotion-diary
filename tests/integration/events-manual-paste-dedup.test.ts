import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { seedUserDirectly } from "./helpers.js";

// Phase 3.0 Plan 04 — manual-paste dedup (CONTEXT D-15).
//
// Phase 3.0 post-build (migration 0012, 2026-05-06): the partial unique
// (user_id, kind, external_id) index that this test originally pinned was
// DROPPED. UAT direction — operator wants to log multiple promotion events
// for the same upstream video (e.g. "Released video X" + "Promo stream
// for X" + "Reddit post for X" — same external_id, three diary entries
// each with their own attached game / notes / authorIsMe). Auto-import
// idempotency moved to a pre-INSERT SELECT in the worker; manual paste
// is intentionally permissive.
//
// Soft-deleted rows are no longer relevant to the (now absent) partial
// unique index, but the recovery flow still works at the service layer —
// soft-deleting a row and re-pasting still creates a fresh row (it always
// did, the index just used to gate cross-deletion).
//
// Cross-user uniqueness is irrelevant after the drop — two users pasting
// the same URL always yielded independent rows (user_id was the leading
// column on the partial index; cross-user dedup was never on the table).

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("events manual-paste dedup (Plan 03.0-04 post-0012)", () => {
  it("post-0012: second manual paste of same external_id SUCCEEDS — diary intentionally permits multiple events per video", async () => {
    const u = await seedUserDirectly({ email: `dedup-1-${uniq()}@test.local` });

    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const first = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "first paste",
        url,
        externalId: "dQw4w9WgXcQ",
        sourceId: null,
      },
      "127.0.0.1",
    );
    expect(first.id).toBeTruthy();

    // Migration 0012 dropped the (user_id, kind, external_id) partial
    // unique. Second paste creates a SECOND event row — diary use case:
    // "Released X" event + "Reddit post for X" event reference the same
    // upstream video and are both legitimate diary entries.
    const second = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-02T10:00:00Z"),
        title: "second paste (diary entry for same video)",
        url,
        externalId: "dQw4w9WgXcQ",
        sourceId: null,
      },
      "127.0.0.1",
    );
    expect(second.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);

    // Both rows live in events; they share external_id but are independent
    // diary entries with their own occurred_at / title / metadata.
    const both = await db.select().from(events).where(eq(events.userId, u.id));
    expect(both).toHaveLength(2);
    expect(both.every((r) => r.externalId === "dQw4w9WgXcQ")).toBe(true);
  });

  it("Plan 03.0-04: soft-deleted dupe is INVISIBLE to the partial unique index — next paste succeeds", async () => {
    const u = await seedUserDirectly({ email: `dedup-2-${uniq()}@test.local` });

    const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    const first = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "first",
        url,
        externalId: "jNQXAC9IVRw",
      },
      "127.0.0.1",
    );

    // Soft-delete the first row directly (bypasses softDelete service for
    // test setup speed; the partial index treats deleted_at IS NOT NULL as
    // invisible regardless of how the deletion was performed).
    await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, first.id));

    // Re-paste — must succeed (the partial index excludes the soft-deleted row).
    const second = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-03T10:00:00Z"),
        title: "second after delete",
        url,
        externalId: "jNQXAC9IVRw",
      },
      "127.0.0.1",
    );
    expect(second.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);
  });

  it("Plan 03.0-04: different user pasting same URL → both succeed (user-scoped uniqueness)", async () => {
    const a = await seedUserDirectly({ email: `dedup-a-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `dedup-b-${uniq()}@test.local` });

    const url = "https://www.youtube.com/watch?v=9bZkp7q19f0";
    const evA = await createEvent(
      a.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "A",
        url,
        externalId: "9bZkp7q19f0",
      },
      "127.0.0.1",
    );
    const evB = await createEvent(
      b.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-02T10:00:00Z"),
        title: "B",
        url,
        externalId: "9bZkp7q19f0",
      },
      "127.0.0.1",
    );
    expect(evA.id).toBeTruthy();
    expect(evB.id).toBeTruthy();
    expect(evA.id).not.toBe(evB.id);
    expect(evA.userId).not.toBe(evB.userId);
  });
});

// Use uuidv7 to silence "unused import" lint when we don't need to seed extras.
void uuidv7;

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

// Phase 3.0 Plan 04 — manual-paste dedup (CONTEXT D-15).
//
// The new partial unique index `events_user_kind_ext_active_unq` (Plan 01)
// keys off (user_id, kind, external_id) WHERE external_id IS NOT NULL AND
// deleted_at IS NULL. Manual-paste of the same YouTube videoId twice now
// surfaces as AppError 422 'duplicate_event' with metadata.url for the
// user-facing toast (Plan 03.0-08 route surfaces the Paraglide message).
//
// Soft-deleted rows are INVISIBLE to the partial index (deleted_at filter),
// so a user who deletes a row can re-paste the same URL and get a fresh
// row — the recovery affordance from Plan 02.1-14 still works.
//
// Cross-user uniqueness is by construction: user_id is the leading column
// in the index, so two different users pasting the same URL are independent
// rows with independent stats trajectories (D-07 public-data table holds
// the shared snapshot stream; the events rows are tenant-scoped views).

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("events manual-paste dedup (Plan 03.0-04, D-15)", () => {
  it("Plan 03.0-04: second manual paste of same external_id → AppError 422 duplicate_event", async () => {
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
        sourceId: null, // manual paste — source_id NULL
      },
      "127.0.0.1",
    );
    expect(first.id).toBeTruthy();

    let caught: unknown;
    try {
      await createEvent(
        u.id,
        {
          kind: "youtube_video",
          occurredAt: new Date("2026-05-02T10:00:00Z"),
          title: "second paste (duplicate)",
          url,
          externalId: "dQw4w9WgXcQ",
          sourceId: null,
        },
        "127.0.0.1",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as InstanceType<typeof AppError>;
    expect(err.code).toBe("duplicate_event");
    expect(err.status).toBe(422);
    expect(err.metadata).toMatchObject({
      kind: "youtube_video",
      external_id: "dQw4w9WgXcQ",
      url,
    });
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

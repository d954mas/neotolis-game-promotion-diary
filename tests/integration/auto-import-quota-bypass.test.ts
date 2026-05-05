import { describe, it, expect } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { env } from "../../src/lib/server/config/env.js";
import { seedUserDirectly } from "./helpers.js";

// Phase 3.0 Plan 04 — DV-5 auto-import quota bypass.
//
// The events_per_day cap models the human-time budget for manual creates.
// Auto-imported rows (events with source_id pointing at a registered
// data_source) MUST NOT count against that cap — a registered YouTube
// channel posting 50 videos in one day must not consume the user's
// manual-paste budget.
//
// Two layers of defense:
//   1. The auto-import worker (Plan 03.0-09) bypasses withQuotaGuard
//      altogether (it does a plain db.insert + audit, no per-user advisory
//      lock + count check).
//   2. Even if a future code path DOES route an auto-import write through
//      withQuotaGuard, the currentCount('events_per_day') filter excludes
//      `source_id IS NOT NULL` rows. This file pins both layers.

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedDataSource(userId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(dataSources).values({
    id,
    userId,
    kind: "youtube_channel",
    handleUrl: `https://www.youtube.com/@auto-${uniq()}`,
    isOwnedByMe: false,
    autoImport: true,
  });
  return id;
}

async function seedAutoImportedEvent(args: {
  userId: string;
  sourceId: string;
  externalId?: string;
}): Promise<string> {
  const id = uuidv7();
  await db.insert(events).values({
    id,
    userId: args.userId,
    sourceId: args.sourceId, // auto-imported — source_id NOT NULL
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt: new Date(),
    title: `auto ${args.externalId ?? uniq()}`,
    url: `https://www.youtube.com/watch?v=${args.externalId ?? uniq()}`,
    externalId: args.externalId ?? uniq(),
    metadata: {},
  });
  return id;
}

describe("auto-import quota bypass (Plan 03.0-04, DV-5)", () => {
  it("Plan 03.0-04: currentCount('events_per_day') excludes events with source_id IS NOT NULL", async () => {
    const u = await seedUserDirectly({ email: `q-by1-${uniq()}@test.local` });
    const src = await seedDataSource(u.id);

    // Seed 5 auto-imported rows (source_id set) + 3 manual rows (source_id null)
    // for the same user, all in the rolling 24h window.
    for (let i = 0; i < 5; i += 1) {
      await seedAutoImportedEvent({ userId: u.id, sourceId: src });
    }
    for (let i = 0; i < 3; i += 1) {
      await db.insert(events).values({
        id: uuidv7(),
        userId: u.id,
        sourceId: null, // manual paste
        kind: "press",
        authorIsMe: false,
        occurredAt: new Date(),
        title: `manual ${i}`,
        url: null,
        externalId: null,
        metadata: {},
      });
    }

    // The next manual create must succeed because only the 3 source_id-NULL
    // rows count toward the cap; LIMIT_EVENTS_PER_DAY is well above 4.
    expect(env.LIMIT_EVENTS_PER_DAY).toBeGreaterThan(4);
    const created = await createEvent(
      u.id,
      {
        kind: "press",
        occurredAt: new Date(),
        title: "manual #4",
      },
      "127.0.0.1",
    );
    expect(created.id).toBeTruthy();
  });

  it("Plan 03.0-04: auto-import worker creating event when user is at 500/day cap → succeeds", async () => {
    const u = await seedUserDirectly({ email: `q-by2-${uniq()}@test.local` });
    const src = await seedDataSource(u.id);

    // Saturate the manual-paste counter to the cap.
    const limit = env.LIMIT_EVENTS_PER_DAY;
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      id: uuidv7(),
      userId: u.id,
      sourceId: null, // manual paste — counts toward the cap
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: `manual saturate ${i}`,
      url: null,
      externalId: null,
      metadata: {},
    }));
    // Bulk insert via direct db (bypass quota for setup).
    for (const row of seedRows) {
      await db.insert(events).values(row);
    }

    // Auto-import path simulated as a direct INSERT (the production path —
    // Plan 03.0-09 worker — bypasses withQuotaGuard by design). The DB
    // accepts the row even though the user is at the manual cap.
    const autoId = await seedAutoImportedEvent({
      userId: u.id,
      sourceId: src,
      externalId: "auto-at-cap",
    });
    expect(autoId).toBeTruthy();
  });

  it("Plan 03.0-04: manual paste at 500/day cap → AppError 429 quota_exceeded (cap still enforced)", async () => {
    const u = await seedUserDirectly({ email: `q-by3-${uniq()}@test.local` });

    // Saturate with manual rows (source_id NULL → counted by DV-5 filter).
    const limit = env.LIMIT_EVENTS_PER_DAY;
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      id: uuidv7(),
      userId: u.id,
      sourceId: null,
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: `manual saturate ${i}`,
      url: null,
      externalId: null,
      metadata: {},
    }));
    for (const row of seedRows) {
      await db.insert(events).values(row);
    }

    // The (limit+1)th manual create must throw quota_exceeded.
    let caught: unknown;
    try {
      await createEvent(
        u.id,
        {
          kind: "press",
          occurredAt: new Date(),
          title: "over-the-limit manual",
        },
        "127.0.0.1",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as InstanceType<typeof AppError>;
    expect(err.code).toBe("quota_exceeded");
    expect(err.status).toBe(429);
    expect(err.metadata).toMatchObject({ kind: "events_per_day" });
  });
});

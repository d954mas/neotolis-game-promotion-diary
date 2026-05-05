// Phase 3.0 Plan 09 — Phase 4 chart-loader contract pin.
//
// The per-event detail page (Phase 4) reads snapshots from
// youtube_video_snapshots WHERE video_id = events.external_id. The
// snapshot row is tenant-agnostic — public data, no user_id column —
// but the JOIN against events filters by user_id so each tenant only
// sees the snapshot history for events they own.
//
// This is the inverse-of-tenant-scope-rule case (snapshot rows have no
// user_id by design; privacy is preserved by the JOIN, not by row
// ownership). Two tenants pasting the same YouTube URL share the
// snapshot row (1 row in the table); each tenant's chart loader gets
// the same data via different events rows.
//
// Phase 4 inherits this test as the load-bearing contract.

import { describe, it, expect } from "vitest";
import { eq, and, asc } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideoSnapshots } = await import(
  "../../src/lib/server/db/schema/youtube-video-snapshots.js"
);
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("youtube snapshot read contract (Plan 03.0-09 — Phase 4 chart-loader handoff)", () => {
  it("Plan 03.0-09: chart-loader query — JOIN events ON events.external_id = snapshots.video_id WHERE events.user_id=$1 returns shared snapshot data per tenant", async () => {
    const userA = await seedUserDirectly({ email: `read-A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `read-B-${uniq()}@test.local` });

    // Both tenants paste the same YouTube URL — both have an events row,
    // both rows carry the same external_id (videoId).
    const sharedExternalId = `shared_${uniq()}`;
    const eventA = uuidv7();
    const eventB = uuidv7();

    await db.insert(events).values([
      {
        id: eventA,
        userId: userA.id,
        kind: "youtube_video",
        authorIsMe: false,
        occurredAt: new Date("2026-04-01T10:00:00Z"),
        title: "shared video — A's perspective",
        url: `https://www.youtube.com/watch?v=${sharedExternalId}`,
        externalId: sharedExternalId,
        metadata: {},
      },
      {
        id: eventB,
        userId: userB.id,
        kind: "youtube_video",
        authorIsMe: false,
        occurredAt: new Date("2026-04-01T10:00:00Z"),
        title: "shared video — B's perspective",
        url: `https://www.youtube.com/watch?v=${sharedExternalId}`,
        externalId: sharedExternalId,
        metadata: {},
      },
    ]);

    // Insert 3 snapshot rows at different polled_at — public data shared
    // across both tenants by construction (no user_id column).
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const oneDayAgo = new Date(Date.now() - 1 * 86_400_000);
    await db.insert(youtubeVideoSnapshots).values([
      {
        videoId: sharedExternalId,
        polledAt: fiveDaysAgo,
        viewCount: 100,
        likeCount: 5,
        commentCount: 1,
      },
      {
        videoId: sharedExternalId,
        polledAt: threeDaysAgo,
        viewCount: 250,
        likeCount: 12,
        commentCount: 3,
      },
      {
        videoId: sharedExternalId,
        polledAt: oneDayAgo,
        viewCount: 500,
        likeCount: 25,
        commentCount: 7,
      },
    ]);

    // Phase 4 chart-loader query for userA's eventA.
    const aRows = await db
      .select({
        polledAt: youtubeVideoSnapshots.polledAt,
        viewCount: youtubeVideoSnapshots.viewCount,
      })
      .from(youtubeVideoSnapshots)
      .innerJoin(events, eq(events.externalId, youtubeVideoSnapshots.videoId))
      .where(and(eq(events.userId, userA.id), eq(events.id, eventA)))
      .orderBy(asc(youtubeVideoSnapshots.polledAt));

    expect(aRows).toHaveLength(3);
    expect(aRows.map((r) => r.viewCount)).toEqual([100, 250, 500]);

    // Same query for userB's eventB — also 3 rows (snapshot data shared by design).
    const bRows = await db
      .select({
        polledAt: youtubeVideoSnapshots.polledAt,
        viewCount: youtubeVideoSnapshots.viewCount,
      })
      .from(youtubeVideoSnapshots)
      .innerJoin(events, eq(events.externalId, youtubeVideoSnapshots.videoId))
      .where(and(eq(events.userId, userB.id), eq(events.id, eventB)))
      .orderBy(asc(youtubeVideoSnapshots.polledAt));

    expect(bRows).toHaveLength(3);
    expect(bRows.map((r) => r.viewCount)).toEqual([100, 250, 500]);

    // Cross-tenant probe: userA cannot reach userB's eventB by id (the
    // events JOIN filters out cross-tenant access). Result is 0 rows
    // because the WHERE never finds an events row owned by userA with
    // id = eventB.
    const crossTenantRows = await db
      .select({ id: youtubeVideoSnapshots.id })
      .from(youtubeVideoSnapshots)
      .innerJoin(events, eq(events.externalId, youtubeVideoSnapshots.videoId))
      .where(and(eq(events.userId, userA.id), eq(events.id, eventB)));
    expect(crossTenantRows).toHaveLength(0);

    // Direct snapshot read (no events JOIN) returns 3 rows — confirming the
    // snapshot table is genuinely shared (no user_id column to filter on).
    // Tenant isolation comes from the events JOIN, not from the snapshot
    // table itself.
    const directRows = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, sharedExternalId));
    expect(directRows).toHaveLength(3);
  });
});

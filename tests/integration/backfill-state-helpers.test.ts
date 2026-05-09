// Phase 03.0.1 — backfill state helpers integration test.
//
// Exercises mark*/reset* helpers + computeSinceForRefresh against a real
// Postgres connection. Verifies tenant scoping (cross-tenant updates do
// not leak), nullable column updates, и idempotency.
//
// computeSinceForRefresh is pure (covered отдельно in unit test); helpers
// here test the SQL UPDATE side.

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import {
  markSourceLastPolledAt,
  markSourceBackfillFrontier,
  markSourceBackfillComplete,
  resetSourceBackfillComplete,
} from "../../src/lib/server/services/data-sources.js";
import { seedUserDirectly } from "./helpers.js";
import { uuidv7 } from "../../src/lib/server/ids.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedSourceRow(userId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(dataSources).values({
    id,
    userId,
    kind: "youtube_channel",
    handleUrl: `https://www.youtube.com/channel/UC${uniq()}${uniq().slice(0, 8)}aa`,
    isOwnedByMe: true,
    autoImport: false,
    metadata: {},
    backfillTargetSince: new Date(Date.now() - 30 * 86_400_000),
  });
  return id;
}

describe("backfill state helpers", () => {
  let userId: string;
  let sourceId: string;

  beforeEach(async () => {
    const u = await seedUserDirectly({ email: `bsh-${uniq()}@test.local` });
    userId = u.id;
    sourceId = await seedSourceRow(userId);
  });

  it("markSourceLastPolledAt updates last_polled_at to NOW", async () => {
    const before = Date.now();
    await markSourceLastPolledAt(userId, sourceId);
    const [row] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(row?.lastPolledAt).not.toBeNull();
    expect(row!.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("markSourceBackfillFrontier updates backfill_oldest_at", async () => {
    const oldest = new Date("2024-03-15T00:00:00Z");
    await markSourceBackfillFrontier(userId, sourceId, oldest);
    const [row] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(row?.backfillOldestAt?.toISOString()).toBe(oldest.toISOString());
  });

  it("markSourceBackfillComplete sets backfill_complete=true", async () => {
    await markSourceBackfillComplete(userId, sourceId);
    const [row] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(row?.backfillComplete).toBe(true);
  });

  it("resetSourceBackfillComplete sets backfill_complete=false", async () => {
    await markSourceBackfillComplete(userId, sourceId);
    await resetSourceBackfillComplete(userId, sourceId);
    const [row] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    expect(row?.backfillComplete).toBe(false);
  });

  it("cross-tenant update silently no-ops (does not leak)", async () => {
    const otherUser = await seedUserDirectly({ email: `bsh-other-${uniq()}@test.local` });
    // Try to mutate sourceId (owned by userId) via otherUser.id — should no-op.
    await markSourceBackfillComplete(otherUser.id, sourceId);
    const [row] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId));
    // Original row's backfill_complete стал НЕ затронут — cross-tenant filter гарантирует.
    expect(row?.backfillComplete).toBe(false);
    expect(row?.userId).toBe(userId);
  });
});

/**
 * Integration tests for purgeStaleDeletedEvents() service + the worker step
 * that wires it into the daily 4am-PT cron (D-20).
 *
 * Wave 1 Plan 05 ships the service function; Wave 2 Plan 06 adds the call
 * in src/worker/handlers/purge-daily.ts. Both surfaces are exercised here:
 *
 *   - purgeStaleDeletedEvents() directly (service-layer invariants —
 *     retention cutoff, soft-delete-only filter, per-tenant audit grouping,
 *     idempotency, affected_ids omitted at >100).
 *   - handlePurgeDaily() (worker-layer invariants — runs the existing
 *     per-user purgeAccount sweep AND THEN calls purgeStaleDeletedEvents;
 *     a throw from the new step is caught + logged but does NOT propagate
 *     so the outbox cleanup at the tail of the handler still runs).
 *
 * Contract anchors:
 *   - D-20 — extend Phase 03.0 purge.daily cron with a stale-event sweep;
 *            single audit row per affected user_id (per-tenant cursor)
 *   - D-14 — ONE audit row per bulk operation (per-tenant cursor)
 */

import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { purgeStaleDeletedEvents } from "../../src/lib/server/services/purge-account.js";
import { env } from "../../src/lib/server/config/env.js";
import { handlePurgeDaily } from "../../src/worker/handlers/purge-daily.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

/** Seed an event directly with deletedAt set to `deletedAt` (bypasses createEvent for speed). */
async function seedEventWithDeletedAt(userId: string, deletedAt: Date | null): Promise<string> {
  const id = uuidv7();
  await db.insert(events).values({
    id,
    userId,
    kind: "twitter_post",
    occurredAt: new Date(),
    title: `purge-fix-${uniq()}`,
    deletedAt,
  });
  return id;
}

describe("purgeStaleDeletedEvents service (Wave 1 Plan 05)", () => {
  it("D-20 — hard-deletes events with deletedAt < now() - RETENTION_DAYS", async () => {
    const u = await seedUserDirectly({ email: `purge-stale-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    const old = new Date("2026-04-01T10:00:00Z"); // 61 days before now → past retention (default 60)
    const ev = await seedEventWithDeletedAt(u.id, old);

    const result = await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);
    expect(result.affected_count).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(events).where(eq(events.id, ev));
    expect(rows.length).toBe(0);
  });

  it("preserves events with deletedAt within RETENTION_DAYS (still recoverable)", async () => {
    const u = await seedUserDirectly({ email: `purge-recent-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    const recent = new Date("2026-05-20T10:00:00Z"); // 12 days before now → within retention
    const ev = await seedEventWithDeletedAt(u.id, recent);

    await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);
    const rows = await db.select().from(events).where(eq(events.id, ev));
    expect(rows.length).toBe(1);
  });

  it("preserves events with deletedAt IS NULL (live events untouched)", async () => {
    const u = await seedUserDirectly({ email: `purge-live-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    const ev = await seedEventWithDeletedAt(u.id, null);

    await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);
    const rows = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(eq(events.id, ev));
    expect(rows.length).toBe(1);
    expect(rows[0]!.deletedAt).toBeNull();
  });

  it("D-14 — writes ONE audit row events.purge_stale per affected user_id", async () => {
    const u1 = await seedUserDirectly({ email: `purge-audit-a-${uniq()}@test.local` });
    const u2 = await seedUserDirectly({ email: `purge-audit-b-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    const old = new Date("2026-04-01T10:00:00Z");
    await seedEventWithDeletedAt(u1.id, old);
    await seedEventWithDeletedAt(u1.id, old);
    await seedEventWithDeletedAt(u2.id, old);

    await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);

    const auditsU1 = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u1.id), eq(auditLog.action, "events.purge_stale")));
    const auditsU2 = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u2.id), eq(auditLog.action, "events.purge_stale")));
    expect(auditsU1.length).toBe(1);
    expect(auditsU2.length).toBe(1);
    const metaU1 = auditsU1[0]!.metadata as { affected_count?: number } | null;
    const metaU2 = auditsU2[0]!.metadata as { affected_count?: number } | null;
    expect(metaU1?.affected_count).toBe(2);
    expect(metaU2?.affected_count).toBe(1);
  });

  it("audit metadata carries affected_ids and purged_at when N<=100", async () => {
    const u = await seedUserDirectly({ email: `purge-meta-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    const old = new Date("2026-04-01T10:00:00Z");
    const ev1 = await seedEventWithDeletedAt(u.id, old);
    const ev2 = await seedEventWithDeletedAt(u.id, old);

    await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "events.purge_stale")));
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as {
      affected_count?: number;
      affected_ids?: string[];
      purged_at?: string;
    } | null;
    expect(meta?.affected_count).toBe(2);
    expect((meta?.affected_ids ?? []).sort()).toEqual([ev1, ev2].sort());
    expect(meta?.purged_at).toBe(now.toISOString());
  });

  it("idempotent — re-running on empty trash returns affected_count: 0 + no audit row", async () => {
    const u = await seedUserDirectly({ email: `purge-empty-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");

    const result = await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);
    expect(result.affected_count).toBe(0);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "events.purge_stale")));
    expect(audits.length).toBe(0);
  });

  it("retention consistency: purge uses same cutoff as listDeletedEvents/restoreEvent/listFeedPage(trash)", async () => {
    // The bug: purge used hardcoded 30d while the UI read paths used
    // env.RETENTION_DAYS (default 60d). Events in the 31-60 day window
    // would show as restorable in the UI but already be purged by cron.
    // After the fix, all paths use env.RETENTION_DAYS so the 45-day-old
    // event below is BOTH shown in UI AND preserved by purge.
    const u = await seedUserDirectly({ email: `retention-consistency-${uniq()}@test.local` });
    const now = new Date("2026-06-01T10:00:00Z");
    // 45 days old — within 60d retention, would have been purged under old 30d hardcode.
    const midRange = new Date("2026-04-17T10:00:00Z");
    const ev = await seedEventWithDeletedAt(u.id, midRange);

    await purgeStaleDeletedEvents(env.RETENTION_DAYS, now);

    // Event must survive — it's within the retention window.
    const rows = await db.select().from(events).where(eq(events.id, ev));
    expect(rows.length).toBe(1);
  });
});

describe("handlePurgeDaily worker step (Wave 2 Plan 06)", () => {
  it("daily cron runs purgeStaleDeletedEvents — stale events hard-deleted + audit row written", async () => {
    const u = await seedUserDirectly({ email: `purge-daily-step-${uniq()}@test.local` });

    // Seed a stale event (deletedAt = 90d ago, well past RETENTION_DAYS).
    const stale = new Date(Date.now() - 90 * 86_400_000);
    const evStale = await seedEventWithDeletedAt(u.id, stale);

    // The handler must not throw — listPurgeEligibleUsers may return zero
    // accounts (no user.deletedAt at all), but the new step still fires.
    await expect(handlePurgeDaily({ id: "job-step", data: {} })).resolves.toBeUndefined();

    // Stale event hard-deleted by the worker tick.
    const rows = await db.select().from(events).where(eq(events.id, evStale));
    expect(rows.length).toBe(0);

    // Single events.purge_stale audit row written for the affected user.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "events.purge_stale")));
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as { affected_count?: number } | null;
    expect(meta?.affected_count).toBe(1);
  });

  it("daily cron leaves within-retention soft-deleted events alone", async () => {
    const u = await seedUserDirectly({ email: `purge-daily-keep-${uniq()}@test.local` });

    // Seed an event soft-deleted 10d ago (within RETENTION_DAYS).
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const evRecent = await seedEventWithDeletedAt(u.id, recent);

    await expect(handlePurgeDaily({ id: "job-keep", data: {} })).resolves.toBeUndefined();

    // Recent event still present, still soft-deleted.
    const rows = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(eq(events.id, evRecent));
    expect(rows.length).toBe(1);
    expect(rows[0]!.deletedAt).not.toBeNull();

    // No events.purge_stale audit row when nothing was purged.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "events.purge_stale")));
    expect(audits.length).toBe(0);
  });
});

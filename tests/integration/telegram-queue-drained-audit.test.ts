// Telegram queue_drained audit emit — integration tests (real Postgres).
//
// G1/A1: the telegram lane worker emits a `telegram.queue_drained` audit row per
// non-empty tick (via the emitDrained hook → emitQueueDrainedAudit) so
// /admin/quota Telegram observability is no longer permanently zero. These cases
// drive emitQueueDrainedAudit directly (the function the hook invokes) and
// assert telegramObservability.getDailyStats SUMs the row's
// metadata.entries_processed — no DB mocks (CLAUDE.md).
//
// Operator resolution mirrors reddit-cron-handlers.test.ts: env reads
// ADMIN_EMAIL_ALLOWLIST at module load, so we mutate process.env +
// vi.resetModules() + dynamic-import the worker-tick + observability modules
// fresh, reset the operator cache, then invoke.

import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { user } = await import("../../src/lib/server/db/schema/auth.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedAdminUser(email: string): Promise<string> {
  const id = `usr-${uniq()}`;
  await db.insert(user).values({
    id,
    name: "tg-admin",
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/** Reload the worker-tick + observability modules under a fresh
 *  ADMIN_EMAIL_ALLOWLIST, reset the operator cache, and run the supplied work
 *  against the freshly-imported emitQueueDrainedAudit + getDailyStats. */
async function withAllowlist<T>(
  email: string | null,
  fn: (mods: {
    emitQueueDrainedAudit: (stats: {
      queueName: string;
      entriesProcessed: number;
      durationMs: number;
    }) => Promise<void>;
    getDailyStats: () => Promise<{ unitsUsed: number }>;
    getRecentAudit: (limit: number) => Promise<Array<{ action: string }>>;
  }) => Promise<T>,
): Promise<T> {
  const saved = process.env.ADMIN_EMAIL_ALLOWLIST;
  if (email === null) delete process.env.ADMIN_EMAIL_ALLOWLIST;
  else process.env.ADMIN_EMAIL_ALLOWLIST = email;
  try {
    vi.resetModules();
    const tick = await import("../../src/lib/sources/telegram/server/handlers/worker-tick.js");
    const obs = await import("../../src/lib/sources/telegram/server/observability.js");
    tick.__resetTelegramTickCounterForTest();
    return await fn({
      emitQueueDrainedAudit: tick.emitQueueDrainedAudit,
      getDailyStats: () => obs.telegramObservability.quota.getDailyStats(new Date()),
      getRecentAudit: (limit) => obs.telegramObservability.quota.getRecentAudit(limit),
    });
  } finally {
    if (saved === undefined) delete process.env.ADMIN_EMAIL_ALLOWLIST;
    else process.env.ADMIN_EMAIL_ALLOWLIST = saved;
    vi.resetModules();
  }
}

describe("telegram.queue_drained audit (G1/A1)", () => {
  it("a drained tick writes a row that getDailyStats + getRecentAudit reflect", async () => {
    const adminEmail = `tg-drain-${uniq()}@test.local`;
    const adminId = await seedAdminUser(adminEmail);

    await withAllowlist(adminEmail, async (m) => {
      // Baseline (24h window) before this emit.
      const before = await m.getDailyStats();

      await m.emitQueueDrainedAudit({
        queueName: "service_source",
        entriesProcessed: 3,
        durationMs: 42,
      });

      // The row was written under the operator's user_id.
      const rows = await db.execute(sql`
        SELECT user_id, action, metadata FROM audit_log
        WHERE action = 'telegram.queue_drained' AND user_id = ${adminId}
        ORDER BY created_at DESC LIMIT 1
      `);
      const row = (
        rows as unknown as {
          rows: Array<{ user_id: string; action: string; metadata: Record<string, unknown> }>;
        }
      ).rows[0];
      expect(row).toBeDefined();
      expect(row!.action).toBe("telegram.queue_drained");
      expect(row!.metadata.entries_processed).toBe(3);
      expect(row!.metadata.queue_name).toBe("service_source");

      // getDailyStats SUMs entries_processed across the 24h window → +3.
      const after = await m.getDailyStats();
      expect(after.unitsUsed).toBe(before.unitsUsed + 3);

      // getRecentAudit surfaces the telegram verb.
      const recent = await m.getRecentAudit(20);
      expect(recent.some((r) => r.action === "telegram.queue_drained")).toBe(true);
    });
  });

  it("an empty tick (entriesProcessed=0) writes no row", async () => {
    const adminEmail = `tg-empty-${uniq()}@test.local`;
    const adminId = await seedAdminUser(adminEmail);
    await withAllowlist(adminEmail, async (m) => {
      await m.emitQueueDrainedAudit({
        queueName: "service_post",
        entriesProcessed: 0,
        durationMs: 1,
      });
      const rows = await db.execute(sql`
        SELECT 1 FROM audit_log
        WHERE action = 'telegram.queue_drained' AND user_id = ${adminId}
      `);
      expect((rows as unknown as { rows: unknown[] }).rows.length).toBe(0);
    });
  });

  it("empty ADMIN_EMAIL_ALLOWLIST → no operator resolvable → silent skip (no row)", async () => {
    await withAllowlist(null, async (m) => {
      const before = await m.getDailyStats();
      await m.emitQueueDrainedAudit({
        queueName: "user_source",
        entriesProcessed: 5,
        durationMs: 10,
      });
      const after = await m.getDailyStats();
      // No operator → row skipped → no change.
      expect(after.unitsUsed).toBe(before.unitsUsed);
    });
  });
});

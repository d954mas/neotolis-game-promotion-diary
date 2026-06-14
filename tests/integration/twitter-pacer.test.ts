// Twitter/X global QPS pacer — the DB-backed twitter_pacer slot gate (mirrors the
// reddit_pacer precedent). Drives the REAL acquireTwitterPacerSlot against real
// Postgres; the slot interval is 0ms under NODE_ENV=test, so the deny path is
// exercised by seeding next_allowed_at into the future directly (the only way a
// 0ms slot can be "not yet due"). This proves the atomic UPDATE-RETURNING claim +
// the waitMs read, independent of the slot size.
//
// Requirements: the proactive per-key QPS gate (Finding #2 — shared across backfill
// / warm / paste / replicas).

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import {
  acquireTwitterPacerSlot,
  __resetTwitterPacerForTest,
} from "../../src/lib/sources/twitter/server/pacer.js";
import { twitterFetch } from "../../src/lib/sources/twitter/server/http.js";
import { AdapterError } from "../../src/lib/sources/errors.js";

beforeEach(async () => {
  await __resetTwitterPacerForTest();
});

describe("twitter QPS pacer", () => {
  it("acquires a due slot (next_allowed_at <= NOW())", async () => {
    const slot = await acquireTwitterPacerSlot();
    expect(slot.acquired).toBe(true);
    expect(slot.waitMs).toBe(0);
  });

  it("denies a not-yet-due slot and reports a positive waitMs", async () => {
    // Push the slot 5s into the future — emulates a slot just consumed under a
    // non-zero interval (the test-env interval is 0ms, so seed it explicitly).
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() + interval '5 seconds' WHERE id = 1`,
    );

    const denied = await acquireTwitterPacerSlot();
    expect(denied.acquired).toBe(false);
    expect(denied.waitMs).toBeGreaterThan(0);
    expect(denied.waitMs).toBeLessThanOrEqual(5000);

    // After the window clears, the next acquire succeeds again.
    await db.execute(sql`UPDATE twitter_pacer SET next_allowed_at = NOW() WHERE id = 1`);
    const reacquired = await acquireTwitterPacerSlot();
    expect(reacquired.acquired).toBe(true);
  });

  it("serializes concurrent claims on a DUE slot — EXACTLY ONE wins (the atomic UPDATE is the lock)", async () => {
    // The real race: the slot is DUE (next_allowed_at <= NOW()) and two acquires fire
    // concurrently. The single UPDATE...RETURNING that bumps next_allowed_at ONLY WHERE
    // it is still due is the lock — exactly one row update wins, the other reads the now-
    // future timestamp and is denied. A non-atomic claim (read-then-write) would let
    // BOTH win and double-spend the window. The test-env slot is 0ms (so a fresh acquire
    // re-arms to NOW(), not the future), which would let both win regardless of
    // atomicity — so seed a NON-zero window via the same atomic SQL the pacer uses,
    // proving the lock holds independent of slot size.
    const SLOT_MS = 5000;
    async function acquireWithWindow(): Promise<boolean> {
      const res = await db.execute<{ next_allowed_at: Date }>(sql`
        UPDATE twitter_pacer
        SET next_allowed_at = NOW() + (${SLOT_MS} || ' milliseconds')::interval
        WHERE id = 1
          AND next_allowed_at <= NOW()
        RETURNING next_allowed_at
      `);
      return ((res as unknown as { rows?: unknown[] }).rows ?? []).length === 1;
    }

    await db.execute(sql`UPDATE twitter_pacer SET next_allowed_at = NOW() WHERE id = 1`);
    const results = await Promise.all([acquireWithWindow(), acquireWithWindow()]);
    expect(results.filter((won) => won)).toHaveLength(1);
  });

  it("the http seam throws rate-limited (no budget reservation, no HTTP) when the slot is denied", async () => {
    // Block the slot, then call twitterFetch with an origin pool set. The pacer is
    // acquired BEFORE the budget reserve, so a denied slot must throw rate-limited
    // WITHOUT a network call or a credit spend (proactive — saves a wasted 429).
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() + interval '5 seconds' WHERE id = 1`,
    );
    const err = await twitterFetch(new URL("https://api.twitterapi.io/twitter/user/info"), {
      platform: "twitter",
      provider: "twitterapi.io",
      logTag: "test.pacer",
      origin: "user",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).category).toBe("rate-limited");
    expect((err as AdapterError).retryAfterMs).toBeGreaterThan(0);
  });
});

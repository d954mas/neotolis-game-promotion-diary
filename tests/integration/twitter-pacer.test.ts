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

  it("serializes concurrent claims — exactly one wins when the slot is contended", async () => {
    // Block the slot, then fire two concurrent acquires. Both see a future
    // next_allowed_at → both denied (no double-spend of a single slot window).
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() + interval '5 seconds' WHERE id = 1`,
    );
    const [a, b] = await Promise.all([acquireTwitterPacerSlot(), acquireTwitterPacerSlot()]);
    expect([a.acquired, b.acquired]).toEqual([false, false]);
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

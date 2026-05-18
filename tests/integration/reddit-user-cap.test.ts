// Phase 03.1 Plan 06 — Reddit per-user two-axis cap (DV-RDT-7).
//
// Reddit's adapter declares the two-axis sliding-window cap shape:
//   - source-actions  : 5 / 15min (adapter_refresh_queue COUNT of rows
//                       WHERE user_id=$user AND queue_name='user_source')
//   - post-refreshes  : 30 / 15min (adapter_refresh_queue COUNT of rows
//                       WHERE user_id=$user AND queue_name='user_post')
//
// Both axes EXCLUDE cron-driven entries (D-RDT-CAP-COUNTER) — audit rows
// with metadata.flow='auto_passive' AND queue rows with user_id IS NULL.
//
// V-row coverage:
//   V11 (DV-RDT-7) — source-actions 5/15min — 6th attempt within window → 429
//   V12 (DV-RDT-7) — post-refreshes 30/15min — 31st attempt within window → 429
//   V13           — auto_passive flow + service-cron queue rows excluded
//
// Real Postgres via the integration service container; no mocks.

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import {
  checkRedditUserCap,
  writeRedditCapExhaustedAudit,
  redditCapErrorCode,
  REDDIT_USER_CAP,
} from "../../src/lib/sources/reddit/server/quota.js";
import { user } from "../../src/lib/server/db/schema/auth.js";

const userA = `cap-user-A-${Math.random().toString(36).slice(2, 8)}`;
const userB = `cap-user-B-${Math.random().toString(36).slice(2, 8)}`;

// Seed minimal user rows so audit_log writes don't trip any
// downstream FK expectations (audit_log.user_id has no FK since
// migration 0011 but writeAudit + manual INSERTs both reference
// real-shaped IDs anyway).
beforeEach(async () => {
  // afterEach TRUNCATE in tests/setup.ts wipes everything between specs.
  await db.insert(user).values([
    { id: userA, email: `${userA}@test.local`, name: userA, emailVerified: true },
    { id: userB, email: `${userB}@test.local`, name: userB, emailVerified: true },
  ]);
});

describe("Reddit user cap (Phase 03.1 DV-RDT-7)", () => {
  it("REDDIT_USER_CAP constants — 5 / 30 / 15 (v0.1 UAT recalibration)", () => {
    expect(REDDIT_USER_CAP.sourceActionsPerWindow).toBe(5);
    expect(REDDIT_USER_CAP.postRefreshesPerWindow).toBe(30);
    expect(REDDIT_USER_CAP.windowMinutes).toBe(15);
  });

  it("fresh user with 0 history — allowed=true, used=0, reset_in_seconds=900", async () => {
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
    expect(result.cap).toBe(5);
    expect(result.window_minutes).toBe(15);
    expect(result.reset_in_seconds).toBe(900);
    expect(result.axis).toBe("source-actions");
  });

  it("V11: source-actions 5/15min — 6th attempt within window → allowed=false", async () => {
    // INSERT five user_source queue rows for userA. The cap models the
    // NEXT attempt; with 5 prior actions on the lane the 6th must deny.
    // Note: migrated from audit_log-based counter to queue-based counter
    // (matches post-refreshes axis). createSource writes verb='source.added'
    // which the audit-log counter never saw — silent bypass — and queue
    // rows from onSourceCreated are the actual evidence of work happening.
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'user_source', 'sub_poll',
                ${`{"sub":"IndieDev_${i}"}`}::jsonb, ${userA}, 1)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(5);
    expect(result.cap).toBe(5);
    expect(result.window_minutes).toBe(15);
    expect(result.reset_in_seconds).toBeGreaterThanOrEqual(1);
    expect(result.reset_in_seconds).toBeLessThanOrEqual(900);
  });

  it("source-actions: 15+ min old queue rows do NOT count (window slides)", async () => {
    await db.execute(sql`
      INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority, enqueued_at)
      VALUES ('reddit_account', 'user_source', 'sub_poll', '{"sub":"old"}'::jsonb, ${userA}, 1,
              NOW() - INTERVAL '20 minutes')
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("source-actions: service_source rows (cron lane) do NOT count (cap-exempt)", async () => {
    // Mirrors V13 — cron-lane rows are user_id NULL OR queue_name=service_*
    // and don't burn the user-action cap. Counter filters by
    // queue_name='user_source' so even userId-attributed cron work
    // (theoretical edge) is excluded if it landed on the wrong lane.
    await db.execute(sql`
      INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
      VALUES ('reddit_account', 'service_source', 'sub_poll', '{"sub":"cron"}'::jsonb, ${userA}, 1)
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("source-actions: other user's queue rows do NOT count (tenant scope)", async () => {
    await db.execute(sql`
      INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
      VALUES ('reddit_account', 'user_source', 'sub_poll', '{"sub":"x"}'::jsonb, ${userB}, 1)
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("V12: post-refreshes 30/15min — 31st in user_post queue → allowed=false", async () => {
    for (let i = 0; i < 30; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'user_post', 'post_single',
                ${`{"post_id":"t3_test_${i}"}`}::jsonb, ${userA}, 1)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(30);
    expect(result.cap).toBe(30);
    expect(result.window_minutes).toBe(15);
    expect(result.axis).toBe("post-refreshes");
  });

  it("post-refreshes: 29 rows in window → 30th still allowed", async () => {
    for (let i = 0; i < 29; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'user_post', 'post_single',
                ${`{"post_id":"t3_test_${i}"}`}::jsonb, ${userA}, 1)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(29);
  });

  it("V13: service-cron rows (user_id IS NULL) excluded from post-refreshes counter", async () => {
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'service_post', 'post_single', '{}'::jsonb, NULL, 0)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("post-refreshes: service_post queue with user_id=$user does NOT count (wrong lane)", async () => {
    // Defense in depth — only `user_post` queue rows count, not service_post.
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'service_post', 'post_single', '{}'::jsonb, ${userA}, 0)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("post-refreshes: 15+ min old queue rows do NOT count (window slides)", async () => {
    await db.execute(sql`
      INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority, enqueued_at)
      VALUES ('reddit_account', 'user_post', 'post_single', '{"post_id":"t3_old"}'::jsonb, ${userA}, 1,
              NOW() - INTERVAL '20 minutes')
    `);
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("writeRedditCapExhaustedAudit emits audit_log row with structured metadata (source axis)", async () => {
    await writeRedditCapExhaustedAudit({
      userId: userA,
      ipAddress: "127.0.0.1",
      axis: "source-actions",
      cap: 5,
      used: 5,
    });
    const result = await db.execute(sql`
      SELECT action, metadata FROM audit_log
      WHERE user_id = ${userA} AND action = 'reddit.cap_exhausted'
    `);
    const rows = result.rows as Array<{
      action: string;
      metadata: { cap_type: string; cap: number; used: number; window_minutes: number };
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("reddit.cap_exhausted");
    expect(rows[0]!.metadata.cap_type).toBe("source");
    expect(rows[0]!.metadata.cap).toBe(5);
    expect(rows[0]!.metadata.used).toBe(5);
    expect(rows[0]!.metadata.window_minutes).toBe(15);
  });

  it("writeRedditCapExhaustedAudit emits audit_log row with cap_type='post' for post axis", async () => {
    await writeRedditCapExhaustedAudit({
      userId: userA,
      ipAddress: "127.0.0.1",
      axis: "post-refreshes",
      cap: 30,
      used: 30,
    });
    const result = await db.execute(sql`
      SELECT metadata FROM audit_log
      WHERE user_id = ${userA} AND action = 'reddit.cap_exhausted'
    `);
    const rows = result.rows as Array<{
      metadata: { cap_type: string; cap: number; used: number; window_minutes: number };
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.cap_type).toBe("post");
    expect(rows[0]!.metadata.cap).toBe(30);
    expect(rows[0]!.metadata.used).toBe(30);
  });

  it("redditCapErrorCode maps axes to D-RDT-CAP-EXCEED error codes", () => {
    expect(redditCapErrorCode("source-actions")).toBe("reddit_source_quota_exhausted");
    expect(redditCapErrorCode("post-refreshes")).toBe("reddit_post_quota_exhausted");
  });
});

// Phase 03.1 Plan 06 — Reddit per-user two-axis cap (DV-RDT-7).
//
// Reddit's adapter declares the two-axis sliding-window cap shape:
//   - source-actions  : 1 / 5min (audit_log COUNT of
//                       'source.refresh_content_requested' rows w/
//                       metadata.platform IN ('reddit_account','reddit_subreddit')
//                       AND metadata.flow != 'auto_passive')
//   - post-refreshes  : 25 / 5min (reddit_refresh_queue COUNT of rows
//                       WHERE user_id=$user AND queue_name='user_post')
//
// Both axes EXCLUDE cron-driven entries (D-RDT-CAP-COUNTER) — audit rows
// with metadata.flow='auto_passive' AND queue rows with user_id IS NULL.
//
// V-row coverage:
//   V11 (DV-RDT-7) — source-actions 1/5min — 2nd attempt within window → 429
//   V12 (DV-RDT-7) — post-refreshes 25/5min — 26th attempt within window → 429
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
import { uuidv7 } from "../../src/lib/server/ids.js";

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
  it("REDDIT_USER_CAP constants — 1 / 25 / 5", () => {
    expect(REDDIT_USER_CAP.sourceActionsPerWindow).toBe(1);
    expect(REDDIT_USER_CAP.postRefreshesPerWindow).toBe(25);
    expect(REDDIT_USER_CAP.windowMinutes).toBe(5);
  });

  it("fresh user with 0 history — allowed=true, used=0, reset_in_seconds=300", async () => {
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
    expect(result.cap).toBe(1);
    expect(result.window_minutes).toBe(5);
    expect(result.reset_in_seconds).toBe(300);
    expect(result.axis).toBe("source-actions");
  });

  it("V11: source-actions 1/5min — 2nd attempt within window → allowed=false", async () => {
    // INSERT one source.refresh_content_requested row for userA with
    // platform=reddit_account. The first attempt has already consumed the
    // 1/5min budget; the cap check models the NEXT attempt and reports
    // it as denied.
    await db.execute(sql`
      INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
      VALUES (${uuidv7()}, ${userA}, 'source.refresh_content_requested', '0.0.0.0',
              '{"platform":"reddit_account","flow":"incremental"}'::jsonb, NOW())
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(1);
    expect(result.cap).toBe(1);
    expect(result.window_minutes).toBe(5);
    // reset window narrows as time passes; should be ≤ 300 and ≥ 1.
    expect(result.reset_in_seconds).toBeGreaterThanOrEqual(1);
    expect(result.reset_in_seconds).toBeLessThanOrEqual(300);
  });

  it("source-actions: 5+ min old audit rows do NOT count (window slides)", async () => {
    // Row 10 minutes ago — outside the 5-min sliding window.
    await db.execute(sql`
      INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
      VALUES (${uuidv7()}, ${userA}, 'source.refresh_content_requested', '0.0.0.0',
              '{"platform":"reddit_account","flow":"incremental"}'::jsonb,
              NOW() - INTERVAL '10 minutes')
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("source-actions: reddit_subreddit platform ALSO counts (both reddit_* platforms)", async () => {
    await db.execute(sql`
      INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
      VALUES (${uuidv7()}, ${userA}, 'source.refresh_content_requested', '0.0.0.0',
              '{"platform":"reddit_subreddit","flow":"incremental"}'::jsonb, NOW())
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(1);
  });

  it("source-actions: youtube_channel platform does NOT count (per-platform cap isolation)", async () => {
    await db.execute(sql`
      INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
      VALUES (${uuidv7()}, ${userA}, 'source.refresh_content_requested', '0.0.0.0',
              '{"platform":"youtube_channel","flow":"incremental"}'::jsonb, NOW())
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("V13: auto_passive flow excluded from source-actions counter", async () => {
    // 5 audit rows with metadata.flow='auto_passive' for userA → cron-driven,
    // not counted toward user-action cap.
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
        VALUES (${uuidv7()}, ${userA}, 'source.refresh_content_requested', '0.0.0.0',
                '{"platform":"reddit_account","flow":"auto_passive"}'::jsonb, NOW())
      `);
    }
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("source-actions: other user's audit rows do NOT count (tenant scope)", async () => {
    await db.execute(sql`
      INSERT INTO audit_log (id, user_id, action, ip_address, metadata, created_at)
      VALUES (${uuidv7()}, ${userB}, 'source.refresh_content_requested', '0.0.0.0',
              '{"platform":"reddit_account","flow":"incremental"}'::jsonb, NOW())
    `);
    const result = await checkRedditUserCap(db, userA, "source-actions");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("V12: post-refreshes 25/5min — 26th in user_post queue → allowed=false", async () => {
    for (let i = 0; i < 25; i++) {
      await db.execute(sql`
        INSERT INTO reddit_refresh_queue (queue_name, type, payload, user_id, priority)
        VALUES ('user_post', 'post_single',
                ${`{"post_id":"t3_test_${i}"}`}::jsonb, ${userA}, 1)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(25);
    expect(result.cap).toBe(25);
    expect(result.window_minutes).toBe(5);
    expect(result.axis).toBe("post-refreshes");
  });

  it("post-refreshes: 24 rows in window → 25th still allowed", async () => {
    for (let i = 0; i < 24; i++) {
      await db.execute(sql`
        INSERT INTO reddit_refresh_queue (queue_name, type, payload, user_id, priority)
        VALUES ('user_post', 'post_single',
                ${`{"post_id":"t3_test_${i}"}`}::jsonb, ${userA}, 1)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(24);
  });

  it("V13: service-cron rows (user_id IS NULL) excluded from post-refreshes counter", async () => {
    for (let i = 0; i < 50; i++) {
      await db.execute(sql`
        INSERT INTO reddit_refresh_queue (queue_name, type, payload, user_id, priority)
        VALUES ('service_post', 'post_batch', '{}'::jsonb, NULL, 0)
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
        INSERT INTO reddit_refresh_queue (queue_name, type, payload, user_id, priority)
        VALUES ('service_post', 'post_batch', '{}'::jsonb, ${userA}, 0)
      `);
    }
    const result = await checkRedditUserCap(db, userA, "post-refreshes");
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it("post-refreshes: 6+ min old queue rows do NOT count (window slides)", async () => {
    await db.execute(sql`
      INSERT INTO reddit_refresh_queue (queue_name, type, payload, user_id, priority, enqueued_at)
      VALUES ('user_post', 'post_single', '{"post_id":"t3_old"}'::jsonb, ${userA}, 1,
              NOW() - INTERVAL '10 minutes')
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
      cap: 1,
      used: 1,
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
    expect(rows[0]!.metadata.cap).toBe(1);
    expect(rows[0]!.metadata.used).toBe(1);
    expect(rows[0]!.metadata.window_minutes).toBe(5);
  });

  it("writeRedditCapExhaustedAudit emits audit_log row with cap_type='post' for post axis", async () => {
    await writeRedditCapExhaustedAudit({
      userId: userA,
      ipAddress: "127.0.0.1",
      axis: "post-refreshes",
      cap: 25,
      used: 25,
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
    expect(rows[0]!.metadata.cap).toBe(25);
    expect(rows[0]!.metadata.used).toBe(25);
  });

  it("redditCapErrorCode maps axes to D-RDT-CAP-EXCEED error codes", () => {
    expect(redditCapErrorCode("source-actions")).toBe("reddit_source_quota_exhausted");
    expect(redditCapErrorCode("post-refreshes")).toBe("reddit_post_quota_exhausted");
  });
});

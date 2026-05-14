// Phase 03.1 Plan 05B — Reddit cron handlers (D-RDT-CRON-BURST).
//
// Four pure-DB cron handlers that fire ZERO Reddit HTTP calls:
//
//   1. handleEnqueueServiceSourcesCron — 0/6/12/18 UTC.
//      Scans data_sources for auto_import=true reddit_account /
//      reddit_subreddit rows and INSERTs one reddit_refresh_queue row
//      per source with queue_name='service_source' + type='author_poll'
//      or 'sub_poll'.
//
//   2. handleEnqueueServicePostsCron — 03/09/15/21 UTC.
//      Runs D-RDT-POST-ELIGIBILITY scan against reddit_posts and INSERTs
//      batched payloads (chunks of <=100 post_ids) into
//      reddit_refresh_queue with queue_name='service_post' +
//      type='post_batch'.
//
//   3. handleBaselinesCron — 04:00 UTC.
//      Runs D-RDT-BASELINES-COMPUTE PERCENTILE_CONT aggregate against
//      reddit_posts JOIN reddit_post_snapshots at the ~24h-after-submit
//      mark and UPSERTs reddit_subreddit_baselines for '30d' and
//      'all_time' windows. HAVING COUNT(*) >= 5 guard.
//
//   4. handleDeletionPropagationCron — 05:00 UTC.
//      UPDATEs reddit_posts SET author=NULL, author_fullname=NULL WHERE
//      deletion_detected_at < NOW()-48h. Emits reddit.deletion_propagated
//      audit row with metadata.posts_purged=N when N > 0.
//
// Tests seed synthetic DB state and assert per-handler contracts; no
// Reddit HTTP fires (handlers are pure-DB by construction).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { user } from "../../src/lib/server/db/schema/auth.js";
import { handleEnqueueServiceSourcesCron } from "../../src/lib/sources/reddit/server/handlers/enqueue-service-sources-cron.js";
import { handleEnqueueServicePostsCron } from "../../src/lib/sources/reddit/server/handlers/enqueue-service-posts-cron.js";
import { handleBaselinesCron } from "../../src/lib/sources/reddit/server/handlers/baselines-cron.js";

const uniq = () => Math.random().toString(36).slice(2, 10);

beforeEach(async () => {
  await db.execute(sql`DELETE FROM reddit_refresh_queue`);
  await db.execute(sql`DELETE FROM reddit_subreddit_baselines`);
  await db.execute(sql`DELETE FROM reddit_post_snapshots`);
  await db.execute(sql`DELETE FROM reddit_posts`);
  await db.execute(sql`DELETE FROM audit_log WHERE action::text LIKE 'reddit.%'`);
  await db.execute(
    sql`DELETE FROM data_sources WHERE kind IN ('reddit_account', 'reddit_subreddit')`,
  );
});

/** Insert a user row + return its id. audit_log.user_id is notNull; the
 *  deletion-propagation cron needs an operator user id resolvable through
 *  ADMIN_EMAIL_ALLOWLIST or a fallback. Tests seed an admin user and set
 *  ADMIN_EMAIL_ALLOWLIST via process.env to make resolveOperatorUserId
 *  return that user. */
async function seedAdminUser(email: string): Promise<string> {
  const id = `usr-${uniq()}`;
  await db.insert(user).values({
    id,
    name: "admin-cron",
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedTenantUser(): Promise<string> {
  const id = `usr-${uniq()}`;
  await db.insert(user).values({
    id,
    name: `t-${uniq()}`,
    email: `${id}@test.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function seedRedditSource(args: {
  userId: string;
  kind: "reddit_account" | "reddit_subreddit";
  handle: string;
  autoImport?: boolean;
  deletedAt?: Date | null;
}): Promise<string> {
  const metadata =
    args.kind === "reddit_account" ? { username: args.handle } : { subreddit: args.handle };
  const handleUrl =
    args.kind === "reddit_account"
      ? `https://reddit.com/user/${args.handle}`
      : `https://reddit.com/r/${args.handle}`;
  const rows = await db
    .insert(dataSources)
    .values({
      userId: args.userId,
      kind: args.kind,
      handleUrl,
      channelId: args.handle,
      displayName: args.handle,
      isOwnedByMe: args.kind === "reddit_account",
      autoImport: args.autoImport ?? true,
      metadata,
      deletedAt: args.deletedAt ?? null,
    })
    .returning({ id: dataSources.id });
  return rows[0]!.id;
}

describe("handleEnqueueServiceSourcesCron — daily enqueue from data_sources", () => {
  it("no Reddit sources → no-op (enqueued=0)", async () => {
    const r = await handleEnqueueServiceSourcesCron();
    expect(r.enqueued).toBe(0);
    const queueRows = await db.execute(sql`SELECT COUNT(*) AS c FROM reddit_refresh_queue`);
    expect(
      Number((queueRows as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c),
    ).toBe(0);
  });

  it("mixes reddit_account + reddit_subreddit with auto_import=true → enqueues service_source rows with correct type", async () => {
    const u = await seedTenantUser();
    await seedRedditSource({ userId: u, kind: "reddit_account", handle: "alice" });
    await seedRedditSource({ userId: u, kind: "reddit_account", handle: "bob" });
    await seedRedditSource({ userId: u, kind: "reddit_subreddit", handle: "indiedev" });
    await seedRedditSource({ userId: u, kind: "reddit_subreddit", handle: "gamedev" });

    const r = await handleEnqueueServiceSourcesCron();
    expect(r.enqueued).toBe(4);

    const rows = await db.execute(sql`
      SELECT queue_name, type, payload, user_id
      FROM reddit_refresh_queue
      ORDER BY id ASC
    `);
    const list = (
      rows as unknown as {
        rows: Array<{
          queue_name: string;
          type: string;
          payload: Record<string, unknown>;
          user_id: string | null;
        }>;
      }
    ).rows;
    expect(list.length).toBe(4);
    for (const r of list) {
      expect(r.queue_name).toBe("service_source");
      expect(r.user_id).toBeNull();
    }
    const types = list.map((r) => r.type).sort();
    expect(types).toEqual(["author_poll", "author_poll", "sub_poll", "sub_poll"]);
    const handles = list
      .map((r) => (r.type === "author_poll" ? r.payload.handle : r.payload.sub))
      .sort();
    expect(handles).toEqual(["alice", "bob", "gamedev", "indiedev"]);
  });

  it("auto_import=false rows are skipped", async () => {
    const u = await seedTenantUser();
    await seedRedditSource({
      userId: u,
      kind: "reddit_account",
      handle: "passive",
      autoImport: false,
    });
    await seedRedditSource({
      userId: u,
      kind: "reddit_subreddit",
      handle: "active",
      autoImport: true,
    });
    const r = await handleEnqueueServiceSourcesCron();
    expect(r.enqueued).toBe(1);
    const rows = await db.execute(
      sql`SELECT payload FROM reddit_refresh_queue WHERE type = 'sub_poll'`,
    );
    expect(
      (rows as unknown as { rows: Array<{ payload: { sub: string } }> }).rows[0]!.payload.sub,
    ).toBe("active");
  });

  it("soft-deleted rows are skipped", async () => {
    const u = await seedTenantUser();
    await seedRedditSource({
      userId: u,
      kind: "reddit_subreddit",
      handle: "gone",
      deletedAt: new Date(),
    });
    await seedRedditSource({ userId: u, kind: "reddit_subreddit", handle: "live" });
    const r = await handleEnqueueServiceSourcesCron();
    expect(r.enqueued).toBe(1);
  });
});

describe("handleEnqueueServicePostsCron — D-RDT-POST-ELIGIBILITY scan + batched enqueue", () => {
  async function insertPost(args: {
    postId: string;
    submittedHoursAgo: number;
    lastSnapshotHoursAgo?: number | null;
    deletionDetectedHoursAgo?: number | null;
  }): Promise<void> {
    const submittedAt = sql`NOW() - INTERVAL '${sql.raw(String(args.submittedHoursAgo))} hours'`;
    const lastSnapshotAt =
      args.lastSnapshotHoursAgo === null
        ? sql`NULL`
        : args.lastSnapshotHoursAgo === undefined
          ? sql`NULL`
          : sql`NOW() - INTERVAL '${sql.raw(String(args.lastSnapshotHoursAgo))} hours'`;
    const deletionDetectedAt =
      args.deletionDetectedHoursAgo == null
        ? sql`NULL`
        : sql`NOW() - INTERVAL '${sql.raw(String(args.deletionDetectedHoursAgo))} hours'`;
    await db.execute(sql`
      INSERT INTO reddit_posts
        (post_id, subreddit, author, author_fullname, permalink, title, submitted_at, last_snapshot_at, deletion_detected_at)
      VALUES
        (${args.postId}, 'r/test', 'op', 't2_op', ${"/r/test/" + args.postId}, 't',
         ${submittedAt}, ${lastSnapshotAt}, ${deletionDetectedAt})
    `);
  }

  it("no eligible posts → no enqueue", async () => {
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(0);
    expect(r.batches).toBe(0);
  });

  it("young post (<24h) + last_snapshot >6h old → eligible; enqueues one post_batch row", async () => {
    await insertPost({ postId: "t3_young1", submittedHoursAgo: 3, lastSnapshotHoursAgo: 8 });
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(1);
    expect(r.batches).toBe(1);
    const rows = await db.execute(sql`
      SELECT queue_name, type, payload, user_id FROM reddit_refresh_queue
    `);
    const list = (
      rows as unknown as {
        rows: Array<{
          queue_name: string;
          type: string;
          payload: { post_ids: string[] };
          user_id: string | null;
        }>;
      }
    ).rows;
    expect(list.length).toBe(1);
    expect(list[0]!.queue_name).toBe("service_post");
    expect(list[0]!.type).toBe("post_batch");
    expect(list[0]!.user_id).toBeNull();
    expect(list[0]!.payload.post_ids).toEqual(["t3_young1"]);
  });

  it("young post (<24h) + last_snapshot fresh (<6h) → NOT eligible", async () => {
    await insertPost({
      postId: "t3_freshly_polled",
      submittedHoursAgo: 3,
      lastSnapshotHoursAgo: 1,
    });
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(0);
  });

  it("young post (<24h) + no last_snapshot → eligible", async () => {
    await insertPost({
      postId: "t3_never_polled",
      submittedHoursAgo: 3,
      lastSnapshotHoursAgo: null,
    });
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(1);
  });

  it("old post (>24h) without 24h-mark snapshot → eligible (baseline backfill)", async () => {
    await insertPost({ postId: "t3_old_no_baseline", submittedHoursAgo: 36 });
    // Insert a snapshot BEFORE the 24h mark so the NOT EXISTS clause matches.
    await db.execute(sql`
      INSERT INTO reddit_post_snapshots (post_id, polled_at, status, score, num_comments)
      VALUES ('t3_old_no_baseline', NOW() - INTERVAL '30 hours', 'ok', 5, 1)
    `);
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(1);
  });

  it("old post (>24h) WITH 24h-mark snapshot → NOT eligible", async () => {
    await insertPost({ postId: "t3_old_with_baseline", submittedHoursAgo: 36 });
    // A snapshot at submitted_at + INTERVAL '25 hours' (>=24h after submit)
    // satisfies the NOT EXISTS clause → this post is NOT eligible.
    await db.execute(sql`
      INSERT INTO reddit_post_snapshots (post_id, polled_at, status, score, num_comments)
      VALUES ('t3_old_with_baseline', NOW() - INTERVAL '11 hours', 'ok', 9, 4)
    `);
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(0);
  });

  it("deletion_detected_at IS NOT NULL → NOT eligible (post is dead)", async () => {
    await insertPost({
      postId: "t3_dead",
      submittedHoursAgo: 3,
      lastSnapshotHoursAgo: 8,
      deletionDetectedHoursAgo: 2,
    });
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(0);
  });

  it("chunks more than 100 eligible posts into batches of 100", async () => {
    // 150 young eligible posts → 2 batches (100 + 50).
    for (let i = 0; i < 150; i++) {
      await insertPost({
        postId: `t3_b${i.toString().padStart(3, "0")}`,
        submittedHoursAgo: 3,
        lastSnapshotHoursAgo: 8,
      });
    }
    const r = await handleEnqueueServicePostsCron();
    expect(r.enqueued).toBe(150);
    expect(r.batches).toBe(2);
    const rows = await db.execute(sql`
      SELECT payload FROM reddit_refresh_queue
      WHERE queue_name = 'service_post' AND type = 'post_batch'
      ORDER BY id ASC
    `);
    const batches = (
      rows as unknown as {
        rows: Array<{ payload: { post_ids: string[] } }>;
      }
    ).rows.map((r) => r.payload.post_ids);
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(100);
    expect(batches[1]!.length).toBe(50);
  });
});

describe("handleBaselinesCron — pure-DB PERCENTILE_CONT aggregate", () => {
  async function seedPostsAndSnapshots(
    sub: string,
    count: number,
    opts: { submittedDaysAgo: number },
  ): Promise<void> {
    // Migration 0034 added FK reddit_subreddit_baselines.subreddit →
    // reddit_subreddits_cache.name. The baselines cron INSERTs INTO that
    // table grouping by reddit_posts.subreddit, so every subreddit a
    // seeded post references MUST have a parent cache row. Production
    // path has this implicit: handlePostSingle UPSERTs the cache row
    // first; this test bypasses that path with direct SQL INSERTs, so
    // we mirror the order explicitly.
    await db.execute(sql`
      INSERT INTO reddit_subreddits_cache (name)
      VALUES (${sub})
      ON CONFLICT (name) DO NOTHING
    `);
    for (let i = 0; i < count; i++) {
      const postId = `t3_${sub}_${i}_${uniq()}`;
      await db.execute(sql`
        INSERT INTO reddit_posts
          (post_id, subreddit, author, author_fullname, permalink, title, submitted_at)
        VALUES
          (${postId}, ${sub}, ${"op" + i}, ${"t2_op" + i},
           ${"/r/" + sub + "/" + postId}, 't',
           NOW() - INTERVAL '${sql.raw(String(opts.submittedDaysAgo))} days')
      `);
      // Insert a snapshot at ~24h after submission (within +/- 1h window).
      const score = (i + 1) * 10;
      const numComments = (i + 1) * 2;
      const upvoteRatio = 0.85;
      await db.execute(sql`
        INSERT INTO reddit_post_snapshots (post_id, polled_at, status, score, num_comments, upvote_ratio)
        VALUES (${postId},
                NOW() - INTERVAL '${sql.raw(String(opts.submittedDaysAgo - 1))} days',
                'ok', ${score}, ${numComments}, ${upvoteRatio})
      `);
    }
  }

  it("subreddit with 5+ snapshotted posts → emits 30d and all_time baseline rows", async () => {
    await seedPostsAndSnapshots("r/popular", 6, { submittedDaysAgo: 5 });
    const r = await handleBaselinesCron();
    expect(r.windows).toBe(2);
    const rows = await db.execute(sql`
      SELECT subreddit, window_label, sample_size, median_score_24h, p75_score_24h
      FROM reddit_subreddit_baselines
      ORDER BY window_label
    `);
    const list = (
      rows as unknown as {
        rows: Array<{
          subreddit: string;
          window_label: string;
          sample_size: number;
          median_score_24h: number;
          p75_score_24h: number;
        }>;
      }
    ).rows;
    expect(list.length).toBe(2);
    expect(list.map((r) => r.window_label).sort()).toEqual(["30d", "all_time"]);
    for (const r of list) {
      expect(r.subreddit).toBe("r/popular");
      expect(r.sample_size).toBeGreaterThanOrEqual(5);
      // 10..60 step 10 → median = 35, p75 = 47.5
      expect(Number(r.median_score_24h)).toBeGreaterThan(0);
      expect(Number(r.p75_score_24h)).toBeGreaterThanOrEqual(Number(r.median_score_24h));
    }
  });

  it("subreddit with <5 snapshotted posts → no row (HAVING guard)", async () => {
    await seedPostsAndSnapshots("r/tiny", 3, { submittedDaysAgo: 5 });
    const r = await handleBaselinesCron();
    expect(r.windows).toBe(2);
    const rows = await db.execute(sql`
      SELECT subreddit FROM reddit_subreddit_baselines WHERE subreddit = 'r/tiny'
    `);
    expect((rows as unknown as { rows: unknown[] }).rows.length).toBe(0);
  });

  it("subreddit too old for 30d window but within all_time → only all_time row emitted", async () => {
    await seedPostsAndSnapshots("r/ancient", 6, { submittedDaysAgo: 60 });
    const r = await handleBaselinesCron();
    expect(r.windows).toBe(2);
    const rows = await db.execute(sql`
      SELECT window_label FROM reddit_subreddit_baselines WHERE subreddit = 'r/ancient'
    `);
    const labels = (rows as unknown as { rows: Array<{ window_label: string }> }).rows.map(
      (r) => r.window_label,
    );
    expect(labels.sort()).toEqual(["all_time"]);
  });

  it("re-running cron UPSERTs (no duplicate rows on PK conflict)", async () => {
    await seedPostsAndSnapshots("r/repeat", 6, { submittedDaysAgo: 5 });
    await handleBaselinesCron();
    await handleBaselinesCron();
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS c FROM reddit_subreddit_baselines WHERE subreddit = 'r/repeat'
    `);
    expect(Number((rows as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c)).toBe(2);
  });
});

describe("handleDeletionPropagationCron — 48h author purge + audit", () => {
  /** Reset modules + reload env + reset cache + invoke the cron with a
   *  fresh ADMIN_EMAIL_ALLOWLIST value. Mirrors admin-quota.test.ts's
   *  pattern: mutate process.env, vi.resetModules(), then dynamic-import. */
  async function runCronWithAllowlist(email: string): Promise<{ purged: number }> {
    const saved = process.env.ADMIN_EMAIL_ALLOWLIST;
    process.env.ADMIN_EMAIL_ALLOWLIST = email;
    try {
      vi.resetModules();
      const mod =
        await import("../../src/lib/sources/reddit/server/handlers/deletion-propagation-cron.js");
      mod.__resetOperatorCacheForTest();
      return await mod.handleDeletionPropagationCron();
    } finally {
      if (saved === undefined) delete process.env.ADMIN_EMAIL_ALLOWLIST;
      else process.env.ADMIN_EMAIL_ALLOWLIST = saved;
      vi.resetModules();
    }
  }

  it("post past 48h deletion_detected_at + author set → author nulled + audit row written", async () => {
    const adminEmail = `admin-${uniq()}@test.local`;
    const adminId = await seedAdminUser(adminEmail);
    await db.execute(sql`
      INSERT INTO reddit_posts
        (post_id, subreddit, author, author_fullname, permalink, title, submitted_at, deletion_detected_at)
      VALUES
        ('t3_del1', 'r/test', 'someuser', 't2_someuser', '/r/test/t3_del1', 't',
         NOW() - INTERVAL '5 days', NOW() - INTERVAL '49 hours')
    `);

    const r = await runCronWithAllowlist(adminEmail);
    expect(r.purged).toBe(1);

    const after = await db.execute(
      sql`SELECT author, author_fullname FROM reddit_posts WHERE post_id = 't3_del1'`,
    );
    const row = (
      after as unknown as {
        rows: Array<{ author: string | null; author_fullname: string | null }>;
      }
    ).rows[0]!;
    expect(row.author).toBeNull();
    expect(row.author_fullname).toBeNull();

    const audit = await db.execute(sql`
      SELECT user_id, action, metadata FROM audit_log
      WHERE action = 'reddit.deletion_propagated'
    `);
    const auditRows = (
      audit as unknown as {
        rows: Array<{ user_id: string; action: string; metadata: { posts_purged?: number } }>;
      }
    ).rows;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.user_id).toBe(adminId);
    expect(auditRows[0]!.metadata?.posts_purged).toBe(1);
  });

  it("post within 48h grace window → author preserved + no audit", async () => {
    const adminEmail = `admin-${uniq()}@test.local`;
    await seedAdminUser(adminEmail);
    await db.execute(sql`
      INSERT INTO reddit_posts
        (post_id, subreddit, author, author_fullname, permalink, title, submitted_at, deletion_detected_at)
      VALUES
        ('t3_recent_del', 'r/test', 'stillthere', 't2_stillthere', '/r/test/t3_recent_del', 't',
         NOW() - INTERVAL '3 days', NOW() - INTERVAL '12 hours')
    `);
    const r = await runCronWithAllowlist(adminEmail);
    expect(r.purged).toBe(0);
    const after = await db.execute(
      sql`SELECT author FROM reddit_posts WHERE post_id = 't3_recent_del'`,
    );
    expect((after as unknown as { rows: Array<{ author: string | null }> }).rows[0]!.author).toBe(
      "stillthere",
    );
    const audit = await db.execute(sql`
      SELECT COUNT(*) AS c FROM audit_log WHERE action = 'reddit.deletion_propagated'
    `);
    expect(Number((audit as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c)).toBe(
      0,
    );
  });

  it("post past 48h but author already NULL → idempotent (no double-audit)", async () => {
    const adminEmail = `admin-${uniq()}@test.local`;
    await seedAdminUser(adminEmail);
    await db.execute(sql`
      INSERT INTO reddit_posts
        (post_id, subreddit, author, author_fullname, permalink, title, submitted_at, deletion_detected_at)
      VALUES
        ('t3_already_null', 'r/test', NULL, NULL, '/r/test/t3_already_null', 't',
         NOW() - INTERVAL '10 days', NOW() - INTERVAL '60 hours')
    `);
    const r = await runCronWithAllowlist(adminEmail);
    expect(r.purged).toBe(0);
    const audit = await db.execute(sql`
      SELECT COUNT(*) AS c FROM audit_log WHERE action = 'reddit.deletion_propagated'
    `);
    expect(Number((audit as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c)).toBe(
      0,
    );
  });

  it("no eligible posts → no-op, no audit row", async () => {
    const adminEmail = `admin-${uniq()}@test.local`;
    await seedAdminUser(adminEmail);
    const r = await runCronWithAllowlist(adminEmail);
    expect(r.purged).toBe(0);
    const audit = await db.execute(sql`
      SELECT COUNT(*) AS c FROM audit_log WHERE action = 'reddit.deletion_propagated'
    `);
    expect(Number((audit as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c)).toBe(
      0,
    );
  });

  it("empty ADMIN_EMAIL_ALLOWLIST → handler still purges but skips audit (silent)", async () => {
    await db.execute(sql`
      INSERT INTO reddit_posts
        (post_id, subreddit, author, author_fullname, permalink, title, submitted_at, deletion_detected_at)
      VALUES
        ('t3_no_admin', 'r/test', 'op', 't2_op', '/r/test/t3_no_admin', 't',
         NOW() - INTERVAL '5 days', NOW() - INTERVAL '50 hours')
    `);
    const r = await runCronWithAllowlist("");
    expect(r.purged).toBe(1);
    const after = await db.execute(
      sql`SELECT author FROM reddit_posts WHERE post_id = 't3_no_admin'`,
    );
    expect(
      (after as unknown as { rows: Array<{ author: string | null }> }).rows[0]!.author,
    ).toBeNull();
    const audit = await db.execute(sql`
      SELECT COUNT(*) AS c FROM audit_log WHERE action = 'reddit.deletion_propagated'
    `);
    expect(Number((audit as unknown as { rows: Array<{ c: number | string }> }).rows[0]!.c)).toBe(
      0,
    );
  });
});

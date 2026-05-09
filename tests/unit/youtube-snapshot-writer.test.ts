import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Seed env BEFORE importing the module under test — matches the established
// unit-test pattern in tests/unit/audit-append-only.test.ts and proxy-trust.
// youtube-snapshot-writer.ts value-imports db/client.js → config/env.js at
// module init time so a complete env shape must exist.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

// Phase 3.0 Plan 04 + post-build refactor (2026-05-06) — youtube-snapshot-
// writer is a thin orchestrator: it does not encode any business logic
// beyond "wrap 3 ops in one tx". The unit-test surface verifies STRUCTURAL
// invariants of the tx callback rather than DB state (DB-state tests live
// in integration/poll-worker-tx-boundary.test.ts).
//
// What we verify here:
//   - one db.transaction() call per writeSnapshot()
//   - status='ok' inside that tx: insert(youtube_video_snapshots) +
//     update(youtube_videos last_polled_at + last_poll_status='ok' +
//     poll_failure_count=0) + incrementUsage()
//   - status!='ok': skips the snapshot insert, still updates youtube_videos
//     (last_poll_status set; poll_failure_count incremented via SQL
//     expression) and increments quota
//   - the youtube_videos UPDATE WHERE clause references video_id (the PK).
//     PUBLIC-DATA TABLE — no userId filter (videos are tenant-agnostic).
//   - the snapshot insert uses date_trunc('minute', now()) for polled_at +
//     ON CONFLICT DO NOTHING (idempotency on retry within the same minute).

const insertCalls: Array<{ table: unknown; values: unknown; conflict: boolean }> = [];
const updateCalls: Array<{ table: unknown; set: unknown; whereSql: string }> = [];
let txCount = 0;

function collectColumnNames(root: unknown): string[] {
  const seen = new WeakSet<object>();
  const out: string[] = [];
  function walk(v: unknown): void {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    const maybeName = (v as { name?: unknown }).name;
    if (typeof maybeName === "string") out.push(maybeName);
    for (const k of Object.keys(v as object)) {
      walk((v as Record<string, unknown>)[k]);
    }
  }
  walk(root);
  return out;
}

vi.mock("../../src/lib/server/db/client.js", () => {
  const makeChain = (): unknown => {
    let pending: { kind: "insert" | "update"; table: unknown } | null = null;
    let pendingValues: unknown = null;
    let pendingSet: unknown = null;
    const chain: Record<string, (...a: unknown[]) => unknown> = {
      insert(table: unknown) {
        pending = { kind: "insert", table };
        return chain;
      },
      values(v: unknown) {
        pendingValues = v;
        return chain;
      },
      onConflictDoNothing() {
        if (pending?.kind === "insert") {
          insertCalls.push({ table: pending.table, values: pendingValues, conflict: true });
          pending = null;
          pendingValues = null;
        }
        return Promise.resolve();
      },
      onConflictDoUpdate() {
        if (pending?.kind === "insert") {
          insertCalls.push({ table: pending.table, values: pendingValues, conflict: true });
          pending = null;
          pendingValues = null;
        }
        return Promise.resolve();
      },
      update(table: unknown) {
        pending = { kind: "update", table };
        return chain;
      },
      set(s: unknown) {
        pendingSet = s;
        return chain;
      },
      where(clause: unknown) {
        if (pending?.kind === "update") {
          updateCalls.push({
            table: pending.table,
            set: pendingSet,
            whereSql: collectColumnNames(clause).join(","),
          });
          pending = null;
          pendingSet = null;
        }
        return Promise.resolve();
      },
    };
    return chain;
  };

  const txCtx = makeChain();
  return {
    db: {
      async transaction(cb: (tx: unknown) => Promise<void>) {
        txCount += 1;
        await cb(txCtx);
      },
    },
    pool: {},
  };
});

// Mock the quota tracker so this test does not depend on plan 03 landing first.
const incrementCalls: Array<{ apiKeyId: string; units: number; hasTx: boolean }> = [];
vi.mock("../../src/lib/sources/youtube/server/quota.js", () => ({
  incrementUsage: async (args: { apiKeyId: string; units: number; tx?: unknown }) => {
    incrementCalls.push({
      apiKeyId: args.apiKeyId,
      units: args.units,
      hasTx: args.tx !== undefined,
    });
  },
}));

const { writeSnapshot } = await import("../../src/lib/sources/youtube/server/snapshots.js");
const { youtubeVideoSnapshots, youtubeVideos } =
  await import("../../src/lib/server/db/schema/index.js");

describe("youtube-snapshot-writer (Plan 03.0-04 + per-video refactor)", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
    incrementCalls.length = 0;
    txCount = 0;
  });

  it("status='ok' inserts snapshot row with polled_at truncated to minute", async () => {
    await writeSnapshot({
      videoId: "VID-ok",
      metrics: { view_count: 100, like_count: 10, comment_count: 5 },
      apiKeyId: "key-abc",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });

    const snapshotInsert = insertCalls.find((c) => c.table === youtubeVideoSnapshots);
    expect(snapshotInsert).toBeDefined();
    const v = snapshotInsert!.values as {
      videoId: string;
      polledAt: { queryChunks?: unknown[] } & Record<string, unknown>;
      viewCount: number;
      likeCount: number;
      commentCount: number;
    };
    expect(v.videoId).toBe("VID-ok");
    expect(v.viewCount).toBe(100);
    expect(v.likeCount).toBe(10);
    expect(v.commentCount).toBe(5);
    const polledAtSerialized = JSON.stringify(v.polledAt);
    expect(polledAtSerialized).toContain("date_trunc");
    expect(polledAtSerialized).toContain("minute");
    expect(polledAtSerialized).toContain("now()");
  });

  it("status='ok' uses ON CONFLICT DO NOTHING (idempotent retry within same minute)", async () => {
    await writeSnapshot({
      videoId: "VID-retry",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-r",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });

    const snapshotInsert = insertCalls.find((c) => c.table === youtubeVideoSnapshots);
    expect(snapshotInsert).toBeDefined();
    expect(snapshotInsert!.conflict).toBe(true);
    await writeSnapshot({
      videoId: "VID-retry",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-r",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });
    const allRetryInserts = insertCalls.filter(
      (c) =>
        c.table === youtubeVideoSnapshots &&
        (c.values as { videoId?: string }).videoId === "VID-retry",
    );
    expect(allRetryInserts.length).toBe(2);
    expect(allRetryInserts.every((c) => c.conflict)).toBe(true);
  });

  it("status='ok' updates youtube_videos.last_polled_at to now() and last_poll_status='ok' and resets poll_failure_count=0", async () => {
    await writeSnapshot({
      videoId: "VID-up",
      metrics: { view_count: 1, like_count: 0, comment_count: 0 },
      apiKeyId: "key-u",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });

    const videosUpdate = updateCalls.find((c) => c.table === youtubeVideos);
    expect(videosUpdate).toBeDefined();
    const setPatch = videosUpdate!.set as {
      lastPolledAt: Date;
      lastPollStatus: string;
      pollFailureCount: number | unknown;
    };
    expect(setPatch.lastPolledAt).toBeInstanceOf(Date);
    expect(setPatch.lastPollStatus).toBe("ok");
    expect(setPatch.pollFailureCount).toBe(0);
  });

  it("status='not_found' updates youtube_videos.last_poll_status but does NOT insert snapshot row", async () => {
    await writeSnapshot({
      videoId: "VID-404",
      metrics: null,
      apiKeyId: "key-n",
      unitsUsed: 1,
      poolKind: "cron",
      status: "not_found",
    });

    const snapshotInsert = insertCalls.find(
      (c) =>
        c.table === youtubeVideoSnapshots &&
        (c.values as { videoId?: string }).videoId === "VID-404",
    );
    expect(snapshotInsert).toBeUndefined();

    const videosUpdate = updateCalls.find((c) => c.table === youtubeVideos);
    expect(videosUpdate).toBeDefined();
    expect((videosUpdate!.set as { lastPollStatus: string }).lastPollStatus).toBe("not_found");
  });

  it("status='private' / 'auth_error' / 'rate_limited' update youtube_videos.last_poll_status accordingly + increment poll_failure_count via SQL expression", async () => {
    for (const status of ["private", "auth_error", "rate_limited"] as const) {
      insertCalls.length = 0;
      updateCalls.length = 0;
      await writeSnapshot({
        videoId: `VID-${status}`,
        metrics: null,
        apiKeyId: "key-x",
        unitsUsed: 1,
        poolKind: "cron",
        status,
      });
      const snapshotInsert = insertCalls.find((c) => c.table === youtubeVideoSnapshots);
      expect(snapshotInsert).toBeUndefined();
      const videosUpdate = updateCalls.find((c) => c.table === youtubeVideos);
      expect(videosUpdate).toBeDefined();
      const setPatch = videosUpdate!.set as {
        lastPollStatus: string;
        pollFailureCount: unknown;
      };
      expect(setPatch.lastPollStatus).toBe(status);
      // Non-ok statuses pass a SQL `<col> + 1` expression (Drizzle SQL chunk)
      // — not a literal number. Walk for the column name reference (the
      // Drizzle SQL chunk graph is circular so JSON.stringify can't be used).
      const failureCols = collectColumnNames(setPatch.pollFailureCount);
      expect(failureCols).toContain("poll_failure_count");
    }
  });

  it("increments youtube_service_quota_usage in same tx (incrementUsage receives tx)", async () => {
    await writeSnapshot({
      videoId: "VID-q",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-q-sha8",
      unitsUsed: 7,
      poolKind: "cron",
      status: "ok",
    });

    expect(incrementCalls.length).toBe(1);
    expect(incrementCalls[0]!.apiKeyId).toBe("key-q-sha8");
    expect(incrementCalls[0]!.units).toBe(7);
    expect(incrementCalls[0]!.hasTx).toBe(true);
  });

  it("wraps all 3 ops in a single db.transaction call", async () => {
    txCount = 0;
    await writeSnapshot({
      videoId: "VID-tx",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-tx",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });
    expect(txCount).toBe(1);
  });

  it("youtube_videos UPDATE keys on video_id (no tenant filter — public-data table)", async () => {
    // Per-video refactor (2026-05-06): polling state moved to youtube_videos
    // which is PUBLIC-DATA (no user_id column). The tenant-scope rule
    // explicitly allowlists this table; the WHERE clause keys on the video_id
    // PK only. Multiple tenants referencing this video share one row.
    await writeSnapshot({
      videoId: "VID-shared",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-tenant",
      unitsUsed: 1,
      poolKind: "cron",
      status: "ok",
    });

    const videosUpdate = updateCalls.find((c) => c.table === youtubeVideos);
    expect(videosUpdate).toBeDefined();
    const cols = videosUpdate!.whereSql.split(",");
    expect(cols).toContain("video_id");
    // No userId — youtube_videos has no user_id column.
    expect(cols).not.toContain("user_id");
  });
});

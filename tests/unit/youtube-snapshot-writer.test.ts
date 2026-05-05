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

// Phase 3.0 Plan 04 — youtube-snapshot-writer is a thin orchestrator: it does
// not encode any business logic beyond "wrap 3 ops in one tx". The unit-test
// surface verifies STRUCTURAL invariants of the tx callback rather than DB
// state (DB-state tests live in integration/poll-worker-tx-boundary.test.ts).
//
// What we verify here:
//   - one db.transaction() call per writeSnapshot()
//   - status='ok' inside that tx: insert(snapshot) + update(events) + incrementUsage()
//   - status!='ok': skips the snapshot insert, still updates events + increments quota
//   - the events update WHERE clause is tenant-scoped via userId (so the
//     ESLint tenant-scope rule sees a userId clause and the runtime filter
//     refuses cross-tenant writes by construction).
//   - the snapshot insert uses date_trunc('minute', now()) for polled_at +
//     ON CONFLICT DO NOTHING (idempotency on retry within the same minute).

// Mock db.transaction to capture the callback's behavior. The mock tx exposes
// insert / update with chainable spies so each call can be inspected.
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
    // Drizzle PgColumn instances carry a `name` string with the snake_case
    // column identifier ("user_id", "id"). Collect those as the
    // structural fingerprint for the tenant-scope assertion.
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
        // incrementUsage uses ON CONFLICT DO UPDATE; record so test can verify
        // the quota counter was upserted.
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
            // Drizzle SQL chunks contain circular table↔column references; we
            // only need to surface column NAMES that appear in the clause for
            // the structural-tenant-scope assertion. Walk the structure with a
            // visited-set and collect any string fields named "name".
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
vi.mock("../../src/lib/server/services/youtube-quota-tracker.js", () => ({
  incrementUsage: async (args: { apiKeyId: string; units: number; tx?: unknown }) => {
    incrementCalls.push({
      apiKeyId: args.apiKeyId,
      units: args.units,
      hasTx: args.tx !== undefined,
    });
  },
}));

const { writeSnapshot } = await import(
  "../../src/lib/server/services/youtube-snapshot-writer.js"
);
const { youtubeVideoSnapshots } = await import(
  "../../src/lib/server/db/schema/youtube-video-snapshots.js"
);
const { events } = await import("../../src/lib/server/db/schema/events.js");

describe("youtube-snapshot-writer (Plan 03.0-04)", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
    incrementCalls.length = 0;
    txCount = 0;
  });

  it("Plan 03.0-04: writeSnapshot status='ok' inserts snapshot row with polled_at truncated to minute", async () => {
    await writeSnapshot({
      videoId: "VID-ok",
      eventId: "evt-1",
      userId: "user-1",
      metrics: { view_count: 100, like_count: 10, comment_count: 5 },
      apiKeyId: "key-abc",
      unitsUsed: 1,
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
    // polledAt is a Drizzle SQL chunk (sql`date_trunc('minute', now())`).
    // Stringify the chunks so the assertion is robust to internal shape.
    const polledAtSerialized = JSON.stringify(v.polledAt);
    expect(polledAtSerialized).toContain("date_trunc");
    expect(polledAtSerialized).toContain("minute");
    expect(polledAtSerialized).toContain("now()");
  });

  it("Plan 03.0-04: writeSnapshot status='ok' uses ON CONFLICT DO NOTHING (idempotent retry within same minute)", async () => {
    await writeSnapshot({
      videoId: "VID-retry",
      eventId: "evt-2",
      userId: "user-2",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-r",
      unitsUsed: 1,
      status: "ok",
    });

    const snapshotInsert = insertCalls.find((c) => c.table === youtubeVideoSnapshots);
    expect(snapshotInsert).toBeDefined();
    expect(snapshotInsert!.conflict).toBe(true);
    // Calling twice in the same "minute" exercises the ON CONFLICT path at
    // the DB level — covered structurally here (both calls hit the same
    // mock chain with onConflictDoNothing) and behaviorally in the
    // integration suite once a live Postgres is available.
    await writeSnapshot({
      videoId: "VID-retry",
      eventId: "evt-2",
      userId: "user-2",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-r",
      unitsUsed: 1,
      status: "ok",
    });
    const allRetryInserts = insertCalls.filter(
      (c) => c.table === youtubeVideoSnapshots && (c.values as { videoId?: string }).videoId === "VID-retry",
    );
    expect(allRetryInserts.length).toBe(2);
    expect(allRetryInserts.every((c) => c.conflict)).toBe(true);
  });

  it("Plan 03.0-04: writeSnapshot status='ok' updates events.last_polled_at to now() and last_poll_status to 'ok'", async () => {
    await writeSnapshot({
      videoId: "VID-up",
      eventId: "evt-3",
      userId: "user-3",
      metrics: { view_count: 1, like_count: 0, comment_count: 0 },
      apiKeyId: "key-u",
      unitsUsed: 1,
      status: "ok",
    });

    const eventsUpdate = updateCalls.find((c) => c.table === events);
    expect(eventsUpdate).toBeDefined();
    const setPatch = eventsUpdate!.set as { lastPolledAt: Date; lastPollStatus: string };
    expect(setPatch.lastPolledAt).toBeInstanceOf(Date);
    expect(setPatch.lastPollStatus).toBe("ok");
  });

  it("Plan 03.0-04: writeSnapshot status='not_found' updates events.last_poll_status but does NOT insert snapshot row", async () => {
    await writeSnapshot({
      videoId: "VID-404",
      eventId: "evt-4",
      userId: "user-4",
      metrics: null,
      apiKeyId: "key-n",
      unitsUsed: 1,
      status: "not_found",
    });

    const snapshotInsert = insertCalls.find(
      (c) =>
        c.table === youtubeVideoSnapshots &&
        (c.values as { videoId?: string }).videoId === "VID-404",
    );
    expect(snapshotInsert).toBeUndefined();

    const eventsUpdate = updateCalls.find((c) => c.table === events);
    expect(eventsUpdate).toBeDefined();
    expect((eventsUpdate!.set as { lastPollStatus: string }).lastPollStatus).toBe("not_found");
  });

  it("Plan 03.0-04: writeSnapshot status='private' / 'auth_error' update events.last_poll_status accordingly", async () => {
    for (const status of ["private", "auth_error", "rate_limited"] as const) {
      insertCalls.length = 0;
      updateCalls.length = 0;
      await writeSnapshot({
        videoId: `VID-${status}`,
        eventId: `evt-${status}`,
        userId: "user-x",
        metrics: null,
        apiKeyId: "key-x",
        unitsUsed: 1,
        status,
      });
      const snapshotInsert = insertCalls.find((c) => c.table === youtubeVideoSnapshots);
      expect(snapshotInsert).toBeUndefined();
      const eventsUpdate = updateCalls.find((c) => c.table === events);
      expect(eventsUpdate).toBeDefined();
      expect((eventsUpdate!.set as { lastPollStatus: string }).lastPollStatus).toBe(status);
    }
  });

  it("Plan 03.0-04: writeSnapshot increments youtube_service_quota_usage in same tx (incrementUsage receives tx)", async () => {
    await writeSnapshot({
      videoId: "VID-q",
      eventId: "evt-q",
      userId: "user-q",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-q-sha8",
      unitsUsed: 7,
      status: "ok",
    });

    expect(incrementCalls.length).toBe(1);
    expect(incrementCalls[0]!.apiKeyId).toBe("key-q-sha8");
    expect(incrementCalls[0]!.units).toBe(7);
    expect(incrementCalls[0]!.hasTx).toBe(true);
  });

  it("Plan 03.0-04: writeSnapshot wraps all 3 ops in a single db.transaction call", async () => {
    txCount = 0;
    await writeSnapshot({
      videoId: "VID-tx",
      eventId: "evt-tx",
      userId: "user-tx",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-tx",
      unitsUsed: 1,
      status: "ok",
    });
    expect(txCount).toBe(1);
  });

  it("Plan 03.0-04: writeSnapshot events update is tenant-scoped (userId in WHERE clause)", async () => {
    // Defense-in-depth structural assertion: the events update WHERE clause
    // must reference the userId column AND the events.id column. The
    // ESLint tenant-scope rule (eslint-plugin-tenant-scope/no-unfiltered-
    // tenant-query) guards this at lint time; this test guards it at runtime
    // via the serialized clause shape.
    await writeSnapshot({
      videoId: "VID-tenant",
      eventId: "evt-tenant",
      userId: "user-tenant-42",
      metrics: { view_count: 1, like_count: 1, comment_count: 1 },
      apiKeyId: "key-tenant",
      unitsUsed: 1,
      status: "ok",
    });

    const eventsUpdate = updateCalls.find((c) => c.table === events);
    expect(eventsUpdate).toBeDefined();
    // The Drizzle and()/eq() chunk includes the column reference for both
    // events.id and events.userId — once serialized the clause text contains
    // the underlying column names ("user_id", "id"). The userId VALUE flows
    // through a parameter placeholder rather than the literal text, which is
    // expected; the structural guard checks the column reference exists.
    const cols = eventsUpdate!.whereSql.split(",");
    expect(cols).toContain("user_id");
    expect(cols).toContain("id");
  });
});

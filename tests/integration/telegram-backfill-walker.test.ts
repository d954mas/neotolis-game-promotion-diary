// Telegram backfill walker — integration tests (real Postgres via ./helpers.js).
//
// Phase 9 Plan 04. Drives the resumable ?before walker by spying on
// telegramChannelAdapterCore.pollListing (the ONE fetch+parse method the handler
// calls) so the walker runs against in-memory fixture pages with NO network.
//
// Assertions:
//   - page 1 writes N snapshots + persists the ?before cursor on the channel-state row
//   - page 2 (driven by the persisted cursor) writes the older posts
//   - an empty / null-cursor page sets backfill_complete=true
//   - the cursor monotonically decreases → no post is fetched twice (we assert
//     pollListing was called with the persisted cursor, never re-fetching page 1)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { telegramPosts, telegramPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const adapterMod = await import("../../src/lib/sources/telegram/server/adapter.js");
const { handleTelegramBackfillWalker, countPendingBackfillContinuations } =
  await import("../../src/lib/sources/telegram/server/handlers/backfill-walker.js");
const { getTelegramWalkState } =
  await import("../../src/lib/sources/telegram/server/walker-state.js");

type ParsedTelegramListing = Awaited<
  ReturnType<typeof adapterMod.telegramChannelAdapterCore.pollListing>
>;

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface FixturePost {
  externalId: string;
  publishedAt: Date | null;
  viewCount: number | null;
}

function listing(posts: FixturePost[], nextBeforeCursor: string | null): ParsedTelegramListing {
  return {
    channelTitle: "Fixture Channel",
    status: "ok",
    posts: posts.map((p) => ({
      externalId: p.externalId,
      publishedAt: p.publishedAt,
      viewCount: p.viewCount,
      textSnippet: "snip",
      mediaKind: null,
      thumbnailUrl: null,
    })),
    nextBeforeCursor,
  };
}

async function snapshotCountFor(postIds: string[]): Promise<number> {
  let total = 0;
  for (const id of postIds) {
    const rows = await db
      .select({ id: telegramPostSnapshots.id })
      .from(telegramPostSnapshots)
      .where(eq(telegramPostSnapshots.postId, id));
    total += rows.length;
  }
  return total;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("telegram backfill walker (Phase 9)", () => {
  it("persists the ?before cursor, fetches the next page from it, and never re-fetches a page", async () => {
    const channel = `walk_${uniq()}`;
    const p1 = [
      { externalId: `${channel}/510`, publishedAt: new Date("2026-06-01T00:00:00Z"), viewCount: 100 },
      { externalId: `${channel}/509`, publishedAt: new Date("2026-05-31T00:00:00Z"), viewCount: 90 },
    ];
    const p2 = [
      { externalId: `${channel}/490`, publishedAt: new Date("2026-05-20T00:00:00Z"), viewCount: 50 },
      { externalId: `${channel}/489`, publishedAt: new Date("2026-05-19T00:00:00Z"), viewCount: 40 },
    ];

    const pollSpy = vi
      .spyOn(adapterMod.telegramChannelAdapterCore, "pollListing")
      .mockResolvedValueOnce(listing(p1, "509")) // newest page → cursor 509
      .mockResolvedValueOnce(listing(p2, "489")); // page from cursor 509 → cursor 489

    // PAGE 1 — no persisted cursor yet, so pollListing is called with null.
    const r1 = await handleTelegramBackfillWalker({ channel });
    expect(r1.status).toBe("ok");
    expect(r1.written).toBe(2);
    expect(r1.backfillComplete).toBe(false);
    expect(pollSpy).toHaveBeenNthCalledWith(1, channel, null);

    // Cursor 509 persisted on the channel-state row.
    const state1 = await getTelegramWalkState(channel);
    expect(state1.beforeCursor).toBe("509");
    expect(state1.backfillComplete).toBe(false);
    expect(await snapshotCountFor(p1.map((p) => p.externalId))).toBe(2);

    // A continuation row was enqueued on the service lane.
    expect(await countPendingBackfillContinuations(channel)).toBeGreaterThanOrEqual(1);

    // PAGE 2 — driven by the persisted cursor 509 (NOT re-fetching page 1 / null).
    const r2 = await handleTelegramBackfillWalker({ channel });
    expect(r2.written).toBe(2);
    expect(pollSpy).toHaveBeenNthCalledWith(2, channel, "509");

    const state2 = await getTelegramWalkState(channel);
    expect(state2.beforeCursor).toBe("489");
    expect(await snapshotCountFor(p2.map((p) => p.externalId))).toBe(2);

    // The cursor monotonically decreased 509 → 489: page 1 was never re-fetched.
    expect(pollSpy.mock.calls.map((c) => c[1])).toEqual([null, "509"]);
  });

  it("sets backfill_complete=true on a null-cursor (end-of-history) page", async () => {
    const channel = `walkend_${uniq()}`;
    const lastPosts = [
      { externalId: `${channel}/2`, publishedAt: new Date("2025-01-02T00:00:00Z"), viewCount: 5 },
      { externalId: `${channel}/1`, publishedAt: new Date("2025-01-01T00:00:00Z"), viewCount: 3 },
    ];
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(lastPosts, null), // no more-anchor → end of history
    );

    const r = await handleTelegramBackfillWalker({ channel });
    expect(r.written).toBe(2);
    expect(r.backfillComplete).toBe(true);
    expect(r.nextBeforeCursor).toBeNull();

    const state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);
    expect(state.beforeCursor).toBeNull(); // cleared on completion

    // backfill_complete column flipped on the channel-state row.
    const [stateRow] = await db
      .select({ backfillComplete: dataSourceChannelState.backfillComplete })
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "telegram_channel"),
          eq(dataSourceChannelState.channelKey, channel),
        ),
      );
    expect(stateRow?.backfillComplete).toBe(true);

    // No continuation enqueued at end-of-history.
    expect(await countPendingBackfillContinuations(channel)).toBe(0);
  });

  it("sets backfill_complete=true on an EMPTY page (zero data-post blocks)", async () => {
    const channel = `walkempty_${uniq()}`;
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing([], "999"), // zero posts even with a cursor → nothing older to drain
    );

    const r = await handleTelegramBackfillWalker({ channel });
    expect(r.written).toBe(0);
    expect(r.backfillComplete).toBe(true);

    const state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);
  });

  it("a completed walk short-circuits — no further fetch, no snapshot", async () => {
    const channel = `walkdone_${uniq()}`;
    // One spy for the whole test. First call drains to completion (null cursor);
    // any further call would return an empty page (so a non-short-circuit would
    // be visibly wrong). The short-circuit means the SECOND walk never calls it.
    const pollSpy = vi
      .spyOn(adapterMod.telegramChannelAdapterCore, "pollListing")
      .mockResolvedValue(
        listing(
          [
            {
              externalId: `${channel}/1`,
              publishedAt: new Date("2025-01-01T00:00:00Z"),
              viewCount: 1,
            },
          ],
          null,
        ),
      );

    // First walk → completion.
    const r1 = await handleTelegramBackfillWalker({ channel });
    expect(r1.backfillComplete).toBe(true);
    expect(pollSpy).toHaveBeenCalledTimes(1);

    // Confirm completion persisted before the second walk.
    const state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);

    // Second walk must short-circuit — pollListing call count stays at 1.
    const r2 = await handleTelegramBackfillWalker({ channel });
    expect(r2.backfillComplete).toBe(true);
    expect(r2.written).toBe(0);
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it("writes a snapshot row per ok post (idempotency guard intact)", async () => {
    const channel = `walksnap_${uniq()}`;
    const posts = [
      { externalId: `${channel}/7`, publishedAt: new Date("2026-06-01T00:00:00Z"), viewCount: 1234 },
    ];
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(posts, null),
    );
    await handleTelegramBackfillWalker({ channel });

    const [postRow] = await db
      .select({ viewless: telegramPosts.lastPollStatus })
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, `${channel}/7`));
    expect(postRow?.viewless).toBe("ok");
    expect(await snapshotCountFor([`${channel}/7`])).toBe(1);
  });
});

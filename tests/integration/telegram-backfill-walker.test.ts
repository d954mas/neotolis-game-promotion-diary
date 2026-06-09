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
import { and, eq, sql } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { telegramPosts, telegramPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const adapterMod = await import("../../src/lib/sources/telegram/server/adapter.js");
const { handleTelegramBackfillWalker, countPendingBackfillContinuations } =
  await import("../../src/lib/sources/telegram/server/handlers/backfill-walker.js");
const { getTelegramWalkState, resetTelegramWalkState, commitTelegramWalkProgress } =
  await import("../../src/lib/sources/telegram/server/walker-state.js");
const { telegramAdapter } = await import("../../src/lib/sources/telegram/server/index.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { seedUserDirectly } = await import("./helpers.js");
const { env } = await import("../../src/lib/server/config/env.js");

type ParsedTelegramListing = Awaited<
  ReturnType<typeof adapterMod.telegramChannelAdapterCore.pollListing>
>;

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface FixturePost {
  externalId: string;
  publishedAt: Date | null;
  viewCount: number | null;
  channelKey?: string | null;
  reactionsTotal?: number | null;
  reactionsTop?: { emoji: string | null; kind: "standard" | "custom" | "paid"; count: number }[];
}

function listing(
  posts: FixturePost[],
  nextBeforeCursor: string | null,
  channelKey: string | null = "-1009999",
): ParsedTelegramListing {
  return {
    channelTitle: "Fixture Channel",
    channelHeader:
      channelKey === null
        ? null
        : {
            channelKey,
            slug: "fixture",
            title: "Fixture Channel",
            avatarUrl: null,
            description: null,
            subscriberCount: null,
          },
    status: "ok",
    posts: posts.map((p) => ({
      externalId: p.externalId,
      channelKey: p.channelKey ?? channelKey,
      publishedAt: p.publishedAt,
      viewCount: p.viewCount,
      textSnippet: "snip",
      mediaKind: null,
      thumbnailUrl: null,
      reactionsTotal: p.reactionsTotal ?? null,
      reactionsTop: p.reactionsTop ?? [],
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
      {
        externalId: `${channel}/510`,
        publishedAt: new Date("2026-06-01T00:00:00Z"),
        viewCount: 100,
      },
      {
        externalId: `${channel}/509`,
        publishedAt: new Date("2026-05-31T00:00:00Z"),
        viewCount: 90,
      },
    ];
    const p2 = [
      {
        externalId: `${channel}/490`,
        publishedAt: new Date("2026-05-20T00:00:00Z"),
        viewCount: 50,
      },
      {
        externalId: `${channel}/489`,
        publishedAt: new Date("2026-05-19T00:00:00Z"),
        viewCount: 40,
      },
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
    expect(pollSpy).toHaveBeenNthCalledWith(1, channel, null, "acquire");

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
    expect(pollSpy).toHaveBeenNthCalledWith(2, channel, "509", "acquire");

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
      {
        externalId: `${channel}/7`,
        publishedAt: new Date("2026-06-01T00:00:00Z"),
        viewCount: 1234,
      },
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

// B1 — the walk is BOUNDED by the deepest subscriber's window + the post-count
// cap, instead of crawling to absolute end-of-history.
describe("telegram backfill walker — window + cap bounding (B1)", () => {
  /** Seed an auto-import telegram_channel source whose backfillTargetSince is the
   *  chosen window. createSource persists the window as the absolute target the
   *  walker reads (resolveDeepestTargetSince). createSource(autoImport=true) also
   *  enqueues an onboarding backfill_page row via onSourceCreated; we clear it so
   *  the continuation-count assertions isolate the WALKER's own enqueue decision
   *  (does it continue past the bound?) from the onboarding kick. */
  async function seedSubscriber(channel: string, targetSince: Date): Promise<void> {
    const user = await seedUserDirectly({ email: `tg-b1-${uniq()}@test.local` });
    await createSource(
      user.id,
      {
        kind: "telegram_channel",
        handleUrl: `https://t.me/${channel}`,
        isOwnedByMe: false,
        autoImport: true,
        backfillTargetSince: targetSince,
      },
      "127.0.0.1",
    );
    await db
      .delete(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "telegram_channel"),
          eq(adapterRefreshQueue.type, "backfill_page"),
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      );
  }

  it("STOPS at the deepest-subscriber window — a more-anchor page is NOT walked past it", async () => {
    const channel = `b1win_${uniq()}`;
    // Subscriber wants posts back to 2026-05-25. The page carries one post inside
    // the window (05-31) and one OLDER than it (05-20) — the walk must snapshot
    // the in-window post, skip the out-of-window one, and mark complete EVEN
    // THOUGH the page still has a more-anchor cursor (would otherwise continue).
    await seedSubscriber(channel, new Date("2026-05-25T00:00:00Z"));
    const posts = [
      {
        externalId: `${channel}/510`,
        publishedAt: new Date("2026-05-31T00:00:00Z"),
        viewCount: 100,
      },
      {
        externalId: `${channel}/505`,
        publishedAt: new Date("2026-05-20T00:00:00Z"),
        viewCount: 90,
      },
    ];
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(posts, "505"), // more-anchor present — only the window bound stops it
    );

    const r = await handleTelegramBackfillWalker({ channel });
    expect(r.written).toBe(1); // only the in-window post snapshotted
    expect(r.backfillComplete).toBe(true); // window crossed → complete despite cursor
    expect(r.nextBeforeCursor).toBeNull();

    const state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);
    // The out-of-window post was NOT snapshotted.
    expect(await snapshotCountFor([`${channel}/510`])).toBe(1);
    expect(await snapshotCountFor([`${channel}/505`])).toBe(0);
    // No continuation enqueued past the window bound.
    expect(await countPendingBackfillContinuations(channel)).toBe(0);
  });

  it("STOPS at TELEGRAM_BACKFILL_MAX_POSTS even with more history + an unbounded window", async () => {
    const channel = `b1cap_${uniq()}`;
    // "everything" subscriber → no date bound; only the post-count cap stops it.
    await seedSubscriber(channel, new Date("1970-01-01T00:00:00Z"));
    // env is a runtime-mutable plain object with a readonly TS type — cast to a
    // mutable view to override the TELEGRAM cap for this case only. The walker
    // reads TELEGRAM_BACKFILL_MAX_POSTS (its OWN cap), NOT IG's
    // SOCIAL_BACKFILL_MAX_POSTS — overriding the latter must NOT bound the walk.
    const mutableEnv = env as {
      TELEGRAM_BACKFILL_MAX_POSTS: number;
      SOCIAL_BACKFILL_MAX_POSTS: number;
    };
    const originalCap = mutableEnv.TELEGRAM_BACKFILL_MAX_POSTS;
    const originalIgCap = mutableEnv.SOCIAL_BACKFILL_MAX_POSTS;
    mutableEnv.TELEGRAM_BACKFILL_MAX_POSTS = 2; // tiny telegram cap for the test
    // Pin IG's cap LARGER so a regression reusing it would NOT stop at 2 — this
    // is the load-bearing guard that the walker reads the telegram cap.
    mutableEnv.SOCIAL_BACKFILL_MAX_POSTS = 999;
    try {
      const posts = [
        { externalId: `${channel}/9`, publishedAt: new Date("2026-06-03T00:00:00Z"), viewCount: 3 },
        { externalId: `${channel}/8`, publishedAt: new Date("2026-06-02T00:00:00Z"), viewCount: 2 },
        { externalId: `${channel}/7`, publishedAt: new Date("2026-06-01T00:00:00Z"), viewCount: 1 },
      ];
      vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
        listing(posts, "7"), // plenty of older history (more-anchor present)
      );

      const r = await handleTelegramBackfillWalker({ channel });
      expect(r.written).toBe(2); // telegram cap reached after 2 posts
      expect(r.backfillComplete).toBe(true); // cap bound → complete
      expect(r.nextBeforeCursor).toBeNull();
      // The 3rd post was never snapshotted (cap hit first).
      expect(await snapshotCountFor([`${channel}/7`])).toBe(0);
      expect(await countPendingBackfillContinuations(channel)).toBe(0);
    } finally {
      mutableEnv.TELEGRAM_BACKFILL_MAX_POSTS = originalCap;
      mutableEnv.SOCIAL_BACKFILL_MAX_POSTS = originalIgCap;
    }
  });

  it("an UNBOUNDED channel (no subscriber row) still walks to end-of-history", async () => {
    // No seedSubscriber — resolveDeepestTargetSince returns null → unbounded.
    const channel = `b1none_${uniq()}`;
    const posts = [
      { externalId: `${channel}/2`, publishedAt: new Date("2020-01-02T00:00:00Z"), viewCount: 5 },
      { externalId: `${channel}/1`, publishedAt: new Date("2020-01-01T00:00:00Z"), viewCount: 3 },
    ];
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(posts, null), // end-of-history is the only stop
    );
    const r = await handleTelegramBackfillWalker({ channel });
    expect(r.written).toBe(2); // both ancient posts snapshotted (no window bound)
    expect(r.backfillComplete).toBe(true); // end-of-history
  });
});

// G3 — widening a COMPLETE channel re-opens the deep walk.
describe("telegram backfill walker — widening re-opens a complete channel (G3)", () => {
  it("resetTelegramWalkState clears complete + cursor on a complete channel", async () => {
    const channel = `g3reset_${uniq()}`;
    // Drive a channel to completion (end-of-history).
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(
        [
          {
            externalId: `${channel}/3`,
            publishedAt: new Date("2025-01-01T00:00:00Z"),
            viewCount: 9,
          },
        ],
        null,
      ),
    );
    await handleTelegramBackfillWalker({ channel });
    let state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);

    const resetCount = await resetTelegramWalkState(channel);
    expect(resetCount).toBe(1); // one complete row reset
    state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(false);
    expect(state.beforeCursor).toBeNull(); // re-enters page 1 (newest)
  });

  it("resetTelegramWalkState is a no-op (0) on a never-walked / incomplete channel", async () => {
    const channel = `g3noop_${uniq()}`;
    expect(await resetTelegramWalkState(channel)).toBe(0);
  });

  it("adapter.resetWalkerStateOnWidening re-enqueues a backfill_page on a complete channel", async () => {
    const channel = `g3widen_${uniq()}`;
    const user = await seedUserDirectly({ email: `tg-g3-${uniq()}@test.local` });
    // Seed an owned auto-import source (sets metadata.channel) but don't trigger
    // the onboarding backfill yet (autoImport=false → no onSourceCreated enqueue).
    const source = await createSource(
      user.id,
      {
        kind: "telegram_channel",
        handleUrl: `https://t.me/${channel}`,
        isOwnedByMe: false,
        autoImport: false,
        backfillTargetSince: new Date("2026-05-01T00:00:00Z"),
      },
      "127.0.0.1",
    );

    // Drive the channel to completion.
    vi.spyOn(adapterMod.telegramChannelAdapterCore, "pollListing").mockResolvedValueOnce(
      listing(
        [
          {
            externalId: `${channel}/4`,
            publishedAt: new Date("2026-05-10T00:00:00Z"),
            viewCount: 2,
          },
        ],
        null,
      ),
    );
    await handleTelegramBackfillWalker({ channel });
    expect((await getTelegramWalkState(channel)).backfillComplete).toBe(true);
    expect(await countPendingBackfillContinuations(channel)).toBe(0);

    // Widen the window to "everything" (deeper than the prior 2026-05-01 +
    // deeper than the frontier 2026-05-10). The hook must clear complete +
    // enqueue a fresh backfill_page.
    await db.transaction(async (tx) => {
      await telegramAdapter.resetWalkerStateOnWidening!(
        {
          id: source.id,
          userId: user.id,
          autoImport: source.autoImport,
          handleUrl: source.handleUrl,
          metadata: (source.metadata ?? {}) as Record<string, unknown>,
          kind: source.kind,
          channelId: source.channelId,
          backfillTargetSince: new Date("1970-01-01T00:00:00Z"),
          isOwnedByMe: source.isOwnedByMe,
        },
        {
          previousTarget: new Date("2026-05-01T00:00:00Z"),
          newTarget: new Date("1970-01-01T00:00:00Z"),
          triggerUserId: user.id,
          ipAddress: "127.0.0.1",
          tx,
        },
      );
    });

    expect((await getTelegramWalkState(channel)).backfillComplete).toBe(false);
    // A fresh backfill_page row was enqueued to re-open the deep walk.
    expect(await countPendingBackfillContinuations(channel)).toBeGreaterThanOrEqual(1);
  });
});

// #2 — backfill continuation must be ATOMIC with the cursor persist AND guarded
// by an expected-cursor CAS so a crash or a concurrent worker can't strand the
// walk or double-enqueue the continuation. These tests call
// commitTelegramWalkProgress directly (the walker-state helper the handler now
// uses) to isolate the race semantics — mirrors reddit-walker-continuation.test.ts.
describe("telegram backfill walker — atomic persist+enqueue + CAS (#2)", () => {
  it("first commit (expected=null on a never-walked channel) persists cursor + enqueues ONE continuation", async () => {
    const channel = `casfirst_${uniq()}`;
    const r = await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: null, // never walked → cursor is null going in
      nextBeforeCursor: "509",
      backfillComplete: false,
      oldestPublishedAt: new Date("2026-05-31T00:00:00Z"),
      collected: 2,
    });
    expect(r.committed).toBe(true);

    // Cursor + collected persisted on the channel-state row.
    const state = await getTelegramWalkState(channel);
    expect(state.beforeCursor).toBe("509");
    expect(state.collected).toBe(2);

    // Exactly ONE continuation row on the service lane.
    expect(await countPendingBackfillContinuations(channel)).toBe(1);
  });

  it("CAS race — two simultaneous commits with the same expected cursor: only one commits + one continuation lands", async () => {
    const channel = `casrace_${uniq()}`;
    // Plant a mid-walk cursor (expected="600") via a first committed tick, then
    // clear the continuation it enqueued so the race assertion counts only the
    // racing pair's continuations.
    await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: null,
      nextBeforeCursor: "600",
      backfillComplete: false,
      oldestPublishedAt: new Date("2026-06-01T00:00:00Z"),
      collected: 1,
    });
    await db
      .delete(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "telegram_channel"),
          eq(adapterRefreshQueue.type, "backfill_page"),
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      );

    // Two replicas both read cursor "600" for the same page and both compute the
    // next cursor "590". Run both commits; assert exactly one wins.
    const [a, b] = await Promise.all([
      commitTelegramWalkProgress(channel, {
        expectedBeforeCursor: "600",
        nextBeforeCursor: "590",
        backfillComplete: false,
        oldestPublishedAt: new Date("2026-05-20T00:00:00Z"),
        collected: 3,
      }),
      commitTelegramWalkProgress(channel, {
        expectedBeforeCursor: "600",
        nextBeforeCursor: "590",
        backfillComplete: false,
        oldestPublishedAt: new Date("2026-05-20T00:00:00Z"),
        collected: 3,
      }),
    ]);
    const wins = [a, b].filter((r) => r.committed).length;
    expect(wins).toBe(1);

    // Exactly ONE continuation enqueued for the page (the CAS-loser skipped it).
    expect(await countPendingBackfillContinuations(channel)).toBe(1);

    const state = await getTelegramWalkState(channel);
    expect(state.beforeCursor).toBe("590");
  });

  it("CAS loser — commit against a STALE expected cursor: no persist, no continuation", async () => {
    const channel = `casstale_${uniq()}`;
    // The row has already advanced to cursor "700".
    await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: null,
      nextBeforeCursor: "700",
      backfillComplete: false,
      oldestPublishedAt: new Date("2026-06-02T00:00:00Z"),
      collected: 1,
    });
    await db
      .delete(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "telegram_channel"),
          eq(adapterRefreshQueue.type, "backfill_page"),
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      );

    // A straggler tick observed an OLDER cursor "650" before the row moved on.
    // Its commit must be rejected (CAS loses) — no persist, no continuation.
    const r = await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: "650",
      nextBeforeCursor: "640",
      backfillComplete: false,
      oldestPublishedAt: new Date("2026-05-15T00:00:00Z"),
      collected: 9,
    });
    expect(r.committed).toBe(false);

    // The cursor is untouched (still "700") and NO continuation was enqueued.
    const state = await getTelegramWalkState(channel);
    expect(state.beforeCursor).toBe("700");
    expect(await countPendingBackfillContinuations(channel)).toBe(0);
  });

  it("end-of-history commit clears the cursor and does NOT enqueue a continuation", async () => {
    const channel = `caseoh_${uniq()}`;
    await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: null,
      nextBeforeCursor: "300",
      backfillComplete: false,
      oldestPublishedAt: new Date("2026-06-01T00:00:00Z"),
      collected: 1,
    });
    await db
      .delete(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "telegram_channel"),
          eq(adapterRefreshQueue.type, "backfill_page"),
          sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
        ),
      );

    const r = await commitTelegramWalkProgress(channel, {
      expectedBeforeCursor: "300",
      nextBeforeCursor: null, // end-of-history
      backfillComplete: true,
      oldestPublishedAt: new Date("2025-01-01T00:00:00Z"),
      collected: 5,
    });
    expect(r.committed).toBe(true);

    const state = await getTelegramWalkState(channel);
    expect(state.backfillComplete).toBe(true);
    expect(state.beforeCursor).toBeNull(); // cleared on completion
    // No continuation at end-of-history.
    expect(await countPendingBackfillContinuations(channel)).toBe(0);
  });
});

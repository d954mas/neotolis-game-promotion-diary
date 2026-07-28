// Reddit resetWalkerStateOnWidening (review P1).
//
// The adapter omitted the resetWalkerStateOnWidening hook, so updateSource's
// `adapter.resetWalkerStateOnWidening !== undefined` guard was false and a widen on a
// COMPLETE Reddit source was a silent no-op — the exhausted walker never re-opened, so
// deeper history never loaded (the case data-sources.ts documents Reddit handling).
// This proves the hook now (a) clears the resumable sub-state and (b) enqueues a
// forceDeep historical walk via the outbox, per-kind. Real Postgres; no provider needed
// (the hook is pure DB + outbox — no HTTP).

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { outbox } = await import("../../src/lib/server/db/schema/index.js");
const { QUEUES } = await import("../../src/lib/server/queues.js");
const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
const { getRedditBackfillState, writeRedditBackfillState } =
  await import("../../src/lib/sources/reddit/server/backfill-state.js");
const { markChannelBackfillComplete, markChannelBackfillFrontier, markChannelLastPolledAt } =
  await import("../../src/lib/server/services/channel-state.js");
const { env } = await import("../../src/lib/server/config/env.js");
const { writeAuditTx } = await import("../../src/lib/server/audit.js");
const { getUserQuotaUsedToday } = await import("../../src/lib/server/daily-user-quota.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

async function seedCompleteAccount(handle: string, frontier: Date): Promise<string> {
  const u = await seedUserDirectly({ email: `rdt-widen-${uniq()}@t.io` });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: u.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle },
    })
    .returning({ id: dataSources.id, userId: dataSources.userId });
  // Walked-to-exhaustion channel state: complete + a recorded frontier.
  await writeRedditBackfillState("reddit_account", handle, {
    cursor: "exhausted-cursor",
    complete: true,
    collected: 17,
    operatorPaused: false,
    deepTargetIso: null,
    emptyPasses: 0,
    notFoundPasses: 0,
    servedDeepTargetIso: null,
  });
  await markChannelBackfillFrontier("reddit_account", handle, frontier);
  await markChannelBackfillComplete("reddit_account", handle);
  await markChannelLastPolledAt("reddit_account", handle);
  return row!.userId;
}

describe("reddit resetWalkerStateOnWidening (review P1)", () => {
  it("widening a COMPLETE source past its frontier resets state + enqueues a forceDeep walk", async () => {
    const handle = `widen_${uniq()}`;
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY);
    const thirtyDaysAgo = new Date(Date.now() - 30 * DAY);
    const userId = await seedCompleteAccount(handle, sevenDaysAgo);

    await db.transaction(async (tx) => {
      await redditAdapter.resetWalkerStateOnWidening!(
        {
          id: "ignored",
          userId,
          kind: "reddit_account",
          channelId: handle,
          autoImport: true,
          isOwnedByMe: true,
          backfillTargetSince: thirtyDaysAgo,
          metadata: { handle },
        } as never,
        {
          previousTarget: sevenDaysAgo,
          newTarget: thirtyDaysAgo,
          triggerUserId: userId,
          ipAddress: "0.0.0.0",
          tx,
        },
      );
    });

    // (a) the resumable sub-state was cleared so the deep walk re-enters page 1.
    const st = await getRedditBackfillState("reddit_account", handle);
    expect(st.complete).toBe(false);
    expect(st.cursor).toBeNull();
    expect(st.collected).toBe(0);

    // (b) a forceDeep historical walk was enqueued via the outbox on the ACCOUNT queue.
    const rows = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(eq(outbox.queue, QUEUES.REDDIT_BACKFILL_ACCOUNT));
    const reopen = rows.find(
      (r) =>
        (r.payload as { channelKey?: string }).channelKey === handle &&
        (r.payload as { forceDeep?: boolean }).forceDeep === true,
    );
    expect(reopen, "widen must re-enqueue a forceDeep walk").toBeTruthy();
    expect((reopen!.payload as { flow?: string }).flow).toBe("historical");
  });

  it("a NON-widen (new target NOT below the frontier) is a no-op — no reset, no enqueue", async () => {
    const handle = `nowiden_${uniq()}`;
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY);
    const threeDaysAgo = new Date(Date.now() - 3 * DAY); // shallower than the 7d frontier
    const userId = await seedCompleteAccount(handle, sevenDaysAgo);

    await db.transaction(async (tx) => {
      await redditAdapter.resetWalkerStateOnWidening!(
        {
          id: "ignored",
          userId,
          kind: "reddit_account",
          channelId: handle,
          autoImport: true,
          isOwnedByMe: true,
          backfillTargetSince: threeDaysAgo,
          metadata: { handle },
        } as never,
        {
          previousTarget: sevenDaysAgo,
          newTarget: threeDaysAgo,
          triggerUserId: userId,
          ipAddress: "0.0.0.0",
          tx,
        },
      );
    });

    // State untouched (still complete), no forceDeep enqueue for this channel.
    const st = await getRedditBackfillState("reddit_account", handle);
    expect(st.complete).toBe(true);
    const rows = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(eq(outbox.queue, QUEUES.REDDIT_BACKFILL_ACCOUNT));
    const reopen = rows.find((r) => (r.payload as { channelKey?: string }).channelKey === handle);
    expect(reopen).toBeUndefined();
  });

  it("channel-state + quota reads ride the caller's tx (pool self-deadlock guard)", async () => {
    // The hook runs INSIDE updateSource's db.transaction. getChannelState and
    // getUserQuotaUsedToday both default `dbCtx` to the module-level `db`, so a
    // revert of the hook's explicit `ctx.tx` arguments COMPILES and passes any
    // test that only uses committed fixtures — while checking out a SECOND pool
    // connection per held transaction, the prod pool-self-deadlock pattern under
    // concurrent widens. Tx-visibility probe (deterministic at any pool size):
    // write the channel state AND cap-exhausting usage UNCOMMITTED inside the tx.
    // The hook can only see them — and therefore only throws
    // requests_quota_exhausted — if BOTH reads ride ctx.tx. Reverted to the
    // default-db reads, a second connection (READ COMMITTED) sees neither: the
    // hook either early-returns on missing channel state or sails past the cap
    // gate, the transaction resolves, and the `rejects` assertion fails.
    const handle = `txwiden_${uniq()}`;
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY);
    const thirtyDaysAgo = new Date(Date.now() - 30 * DAY);
    const u = await seedUserDirectly({ email: `rdt-widen-tx-${uniq()}@t.io` });
    const cap = env.LIMIT_SOCIAL_REQUESTS_PER_DAY;

    await expect(
      db.transaction(async (tx) => {
        // Uncommitted fixtures — visible only through `tx`.
        await markChannelBackfillFrontier("reddit_account", handle, sevenDaysAgo, tx);
        await markChannelBackfillComplete("reddit_account", handle, tx);
        await writeAuditTx(tx, {
          userId: u.id,
          action: "source.refresh_content_requested",
          ipAddress: "0.0.0.0",
          metadata: {
            kind: "reddit_account",
            platform: "reddit_account",
            flow: "incremental",
            requests_used: cap,
            events_inserted: 0,
          },
        });
        // Direct probe: the tx-threaded read sees the uncommitted usage row.
        const used = await getUserQuotaUsedToday(u.id, "reddit_account", tx);
        expect(used.requests).toBe(cap);

        await redditAdapter.resetWalkerStateOnWidening!(
          {
            id: "ignored",
            userId: u.id,
            kind: "reddit_account",
            channelId: handle,
            autoImport: true,
            isOwnedByMe: true,
            backfillTargetSince: thirtyDaysAgo,
            metadata: { handle },
          } as never,
          {
            previousTarget: sevenDaysAgo,
            newTarget: thirtyDaysAgo,
            triggerUserId: u.id,
            ipAddress: "0.0.0.0",
            tx,
          },
        );
      }),
    ).rejects.toMatchObject({ code: "requests_quota_exhausted" });
  });
});

// Reddit graceful degrade (provider off — Phase 12, Plan 12-05). With REDDIT_IMPORT_
// ENABLED unset (the D-08 default-OFF kill-switch), getSocialProvider("reddit") returns
// null and the whole Reddit adapter must degrade to a NO-OP: the walker + the refresh
// lane do nothing, throw nothing, and leave no orphan pending row. Real Postgres; NO
// provider mock (the real null-returning registry is the point).
//
// Requirements: PLAT-04 / SOC-05 / T-12-05-A.
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import { getSocialProvider } from "../../src/lib/sources/reddit/server/provider/registry.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { adapterRefreshQueue, redditPosts } from "../../src/lib/server/db/schema/index.js";
import { dataSourceChannelState } from "../../src/lib/server/db/schema/data-source-channel-state.js";
import { handleBackfillAccount } from "../../src/lib/sources/reddit/server/handlers/backfill-account.js";
import {
  redditRefreshQueueTick,
  __resetRedditRefreshQueueWorkerForTest,
} from "../../src/lib/sources/reddit/server/handlers/refresh-queue-tick.js";

const uniq = (): string => Math.random().toString(36).slice(2, 8);

describe("reddit graceful degrade (provider off — Phase 12)", () => {
  it("sanity: the test process boots with Reddit unconfigured (REDDIT_IMPORT_ENABLED default-OFF)", () => {
    expect(getSocialProvider("reddit")).toBeNull();
  });

  it("[12-05] provider null: the backfill walker is a NO-OP (no throw, no writes, no orphan row)", async () => {
    const handle = `degrade_${uniq()}`;
    const u = await seedUserDirectly({ email: `rdt-degrade-${uniq()}@t.io` });
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle },
    });

    const queueBefore = await db
      .select()
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "reddit_account"));

    await expect(
      handleBackfillAccount({
        data: { kind: "reddit_account", channelKey: handle, depthBoundIso: "1970-01-01T00:00:00Z", flow: "auto_passive" },
      }),
    ).resolves.toBeUndefined();

    // No events, no cache rows, no channel-state row, no orphan queue row.
    const evs = await db.select().from(events).where(eq(events.userId, u.id));
    expect(evs.length).toBe(0);
    const posts = await db.select().from(redditPosts).where(eq(redditPosts.author, handle));
    expect(posts.length).toBe(0);
    const state = await db
      .select()
      .from(dataSourceChannelState)
      .where(and(eq(dataSourceChannelState.kind, "reddit_account"), eq(dataSourceChannelState.channelKey, handle)));
    expect(state.length).toBe(0);
    const queueAfter = await db
      .select()
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "reddit_account"));
    expect(queueAfter.length, "walker enqueued no orphan pending row").toBe(queueBefore.length);
  });

  it("[12-05] provider null: the refresh-queue lane tick is a NO-OP (no throw)", async () => {
    __resetRedditRefreshQueueWorkerForTest();
    await expect(redditRefreshQueueTick()).resolves.toBeDefined();
  });
});

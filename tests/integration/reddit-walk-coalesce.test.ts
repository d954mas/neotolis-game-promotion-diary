// Reddit walk-intent COALESCING (review P1). Real Postgres; the provider fetch is mocked.
//
// `retrySingletonConflict: true` never deduplicated anything: pg-boss refused the
// duplicate send while the first walk was active, its outbox row stayed pending, and the
// next forwarder sweep re-sent it the moment the first job completed — a SECOND full paid
// coverage pass of the same feed per duplicate intent, on the SHARED ScrapeCreators
// prepaid balance. The walk now merges the intents it already satisfies: one provider
// request, and every subscriber (including one created mid-walk) still gets their events.
//
// The mid-walk race is scripted exactly: user B's createSource runs INSIDE the provider
// fetch, so B's subscriber row + B's (conflicted) outbox intent commit while A's walk is
// in flight — the window the fix has to close.
//
// Requirements: PLAT-04 / D-01 (shared prepaid budget).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";
import type { DailyUserRequestAccounting } from "../../src/lib/server/daily-user-quota.js";

const provider = {
  pages: [] as RedditFeedPage[],
  errors: [] as Array<Error | null>,
  onFetch: null as null | (() => Promise<void>),
  calls: 0,
};

function emptyPage(): RedditFeedPage {
  return {
    posts: [],
    nextCursor: null,
    endOfFeed: true,
    creditsUsed: 1,
    owner: null,
    droppedCount: 0,
  };
}

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "reddit" ? ({ name: "scrapecreators-reddit" } as never) : null,
  };
});

vi.mock(
  "../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js",
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      fetchRedditFeedPage: async (
        _mode: string,
        _handle: string,
        _cursor: string | null,
        opts: {
          origin?: "cron" | "user";
          userAccounting?: DailyUserRequestAccounting;
        },
      ): Promise<RedditFeedPage> => {
        if (provider.onFetch !== null) {
          const onFetch = provider.onFetch;
          provider.onFetch = null;
          await onFetch();
        }
        const { reserveSocialCredits } =
          await import("../../src/lib/sources/reddit/server/quota.js");
        const permit =
          opts.origin === "user" && opts.userAccounting !== undefined
            ? await reserveSocialCredits({
                platform: "reddit",
                provider: "scrapecreators",
                origin: "user",
                units: 1,
                userAccounting: opts.userAccounting,
              })
            : await reserveSocialCredits({
                platform: "reddit",
                provider: "scrapecreators",
                origin: opts.origin ?? "cron",
                units: 1,
              });
        if (permit === null) throw new Error("scripted Reddit reservation denied");
        provider.calls += 1;
        const error = provider.errors.shift();
        if (error instanceof Error) throw error;
        return provider.pages.shift() ?? emptyPage();
      },
    };
  },
);

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-account.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

function makePost(shortId: string, daysAgo: number, author: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit: "gamedev",
    title: `Devlog ${shortId}`,
    selftext: "body",
    score: 5,
    num_comments: 2,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/gamedev/comments/${shortId}/devlog/`,
  };
}
function walkPage(posts: unknown[], after: string | null = null): RedditFeedPage {
  return normalizeRedditFeed({ success: true, posts, after });
}

/** The outbox intents still waiting for delivery for this channel. */
async function pendingIntents(handle: string): Promise<
  Array<{
    id: string;
    forwarded_at: Date | null;
    payload: { triggerUserId?: string; flow?: string };
  }>
> {
  return (
    await db.execute(sql`
      SELECT id, forwarded_at, payload
      FROM outbox
      WHERE payload->>'channelKey' = ${handle}
      ORDER BY created_at
    `)
  ).rows as unknown as Array<{
    id: string;
    forwarded_at: Date | null;
    payload: { triggerUserId?: string; flow?: string };
  }>;
}

beforeEach(() => {
  provider.pages = [];
  provider.errors = [];
  provider.onFetch = null;
  provider.calls = 0;
});

describe("reddit walk-intent coalescing (review P1)", () => {
  it("[review-P1] two same-channel source creates ⇒ ONE provider request, events for BOTH tenants, the duplicate intent merged", async () => {
    const handle = `coalesce_${uniq()}`;
    const target = new Date(Date.now() - 7 * DAY);
    const first = await seedUserDirectly({ email: `rdt-coal-a-${handle}@t.io` });
    const second = await seedUserDirectly({ email: `rdt-coal-b-${handle}@t.io` });

    await createSource(
      first.id,
      {
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        autoImport: true,
        backfillTargetSince: target,
      },
      "127.0.0.1",
    );
    const [intentA] = await pendingIntents(handle);
    expect(intentA, "createSource wrote the initial walk intent").toBeDefined();
    // The forwarder delivered A's intent (pg-boss now holds the channel singleton).
    await db.execute(sql`UPDATE outbox SET forwarded_at = NOW() WHERE id = ${intentA!.id}`);

    // …and B registers the SAME channel WHILE A's walk is fetching. B's subscriber row and
    // B's outbox intent commit together, and pg-boss would refuse B's send (A is active).
    const postId = `p${uniq()}`;
    provider.onFetch = async () => {
      await createSource(
        second.id,
        {
          kind: "reddit_account",
          handleUrl: `https://www.reddit.com/user/${handle}`,
          autoImport: true,
          backfillTargetSince: target,
        },
        "127.0.0.1",
      );
    };
    provider.pages = [walkPage([makePost(postId, 1, handle)])];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        triggerUserId: first.id,
        depthBoundIso: target.toISOString(),
        flow: "initial",
      },
    });

    expect(provider.calls, "the merged intent costs NO extra provider request").toBe(1);

    const imported = await db
      .select({ userId: events.userId })
      .from(events)
      .where(eq(events.externalId, `t3_${postId}`));
    expect(imported.map((row) => row.userId).sort(), "both tenants got the post").toEqual(
      [first.id, second.id].sort(),
    );

    const intents = await pendingIntents(handle);
    const intentB = intents.find((row) => row.payload.triggerUserId === second.id);
    expect(intentB, "B's intent row exists").toBeDefined();
    expect(
      intentB!.forwarded_at,
      "B's intent is settled by the merge — the forwarder must NOT replay it as a second paid walk",
    ).not.toBeNull();

    // B still gets their own feedback row, flagged as merged and charging NO request —
    // events_inserted is 0 here because the primary fan-out (B is auto_import) had
    // already inserted B's copy; the row is the trail, not the delivery mechanism.
    const bAudits = await db.select().from(auditLog).where(eq(auditLog.userId, second.id));
    const merged = bAudits.filter(
      (row) =>
        row.action === "source.refresh_content_requested" &&
        (row.metadata as { coalesced?: boolean }).coalesced === true,
    );
    expect(merged, "one merged-intent audit row for B").toHaveLength(1);
    expect(
      (merged[0]!.metadata as { requests_used?: number }).requests_used,
      "a merged intent spends no provider request",
    ).toBe(0);
  });

  it("[review-P1] a merged MANUAL refresh keeps trigger-user semantics: an auto_import=false tenant still gets their events", async () => {
    const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
    const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
    const handle = `coalmanual_${uniq()}`;
    const auto = await seedUserDirectly({ email: `rdt-coalm-a-${handle}@t.io` });
    const manual = await seedUserDirectly({ email: `rdt-coalm-b-${handle}@t.io` });

    await db.insert(dataSources).values({
      userId: auto.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      autoImport: true,
      metadata: { handle },
    });
    const [manualSource] = await db
      .insert(dataSources)
      .values({
        userId: manual.id,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        channelId: handle,
        // auto_import OFF — the cron fan-out deliberately skips this tenant, so ONLY the
        // trigger-user semantics of their own manual intent can import for them. Dropping
        // the intent on merge would silently swallow their "Pull new content" click.
        autoImport: false,
        metadata: { handle },
      })
      .returning({
        id: dataSources.id,
        userId: dataSources.userId,
        metadata: dataSources.metadata,
      });

    const postId = `m${uniq()}`;
    provider.onFetch = async () => {
      await redditAdapter.backfillSource(
        {
          id: manualSource!.id,
          userId: manualSource!.userId,
          metadata: manualSource!.metadata as Record<string, unknown>,
        },
        { userId: manual.id, origin: "user" },
      );
    };
    provider.pages = [walkPage([makePost(postId, 1, handle)])];

    // The in-flight walk is the CRON pass (auto_passive, no trigger user).
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    expect(provider.calls, "still exactly one paid pass").toBe(1);
    const imported = await db
      .select({ userId: events.userId })
      .from(events)
      .where(eq(events.externalId, `t3_${postId}`));
    expect(
      imported.map((row) => row.userId).sort(),
      "the manual tenant's merged intent imported for them",
    ).toEqual([auto.id, manual.id].sort());

    const intents = await pendingIntents(handle);
    const manualIntent = intents.find((row) => row.payload.triggerUserId === manual.id);
    expect(manualIntent!.forwarded_at, "the manual intent is settled by the merge").not.toBeNull();
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, manual.id));
    const merged = audits.filter(
      (row) => (row.metadata as { coalesced?: boolean }).coalesced === true,
    );
    expect(merged, "merged-intent audit for the manual tenant").toHaveLength(1);
    expect((merged[0]!.metadata as { events_inserted?: number }).events_inserted).toBe(1);
    expect((merged[0]!.metadata as { requests_used?: number }).requests_used).toBe(0);
  });

  it("[review-P1] a PAUSED walk merges NOTHING — the pending intent survives for a real walk later", async () => {
    const { AdapterError } = await import("../../src/lib/sources/errors.js");
    const handle = `coalpause_${uniq()}`;
    const target = new Date(Date.now() - 7 * DAY);
    const first = await seedUserDirectly({ email: `rdt-coalp-a-${handle}@t.io` });
    const second = await seedUserDirectly({ email: `rdt-coalp-b-${handle}@t.io` });

    await createSource(
      first.id,
      {
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        autoImport: true,
        backfillTargetSince: target,
      },
      "127.0.0.1",
    );
    const [intentA] = await pendingIntents(handle);
    await db.execute(sql`UPDATE outbox SET forwarded_at = NOW() WHERE id = ${intentA!.id}`);
    await createSource(
      second.id,
      {
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        autoImport: true,
        backfillTargetSince: target,
      },
      "127.0.0.1",
    );

    // The pass is rate-limited on its first page → it proves nothing about coverage.
    provider.errors = [new AdapterError("429 from provider", { category: "rate-limited" })];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        triggerUserId: first.id,
        depthBoundIso: target.toISOString(),
        flow: "initial",
      },
    });

    const intents = await pendingIntents(handle);
    const intentB = intents.find((row) => row.payload.triggerUserId === second.id);
    expect(
      intentB!.forwarded_at,
      "a paused pass must leave the intent pending (it will walk for real)",
    ).toBeNull();
  });

  it("[review-P1] a shallow pass does not settle a deeper intent before the recursive walk succeeds", async () => {
    const handle = `coalcrash_${uniq()}`;
    const shallowTarget = new Date(Date.now() - 7 * DAY);
    const deepTarget = new Date(Date.now() - 30 * DAY);
    const first = await seedUserDirectly({ email: `rdt-coalc-a-${handle}@t.io` });
    const second = await seedUserDirectly({ email: `rdt-coalc-b-${handle}@t.io` });

    await createSource(
      first.id,
      {
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        autoImport: true,
        backfillTargetSince: shallowTarget,
      },
      "127.0.0.1",
    );
    const [intentA] = await pendingIntents(handle);
    await db.execute(sql`UPDATE outbox SET forwarded_at = NOW() WHERE id = ${intentA!.id}`);

    provider.onFetch = async () => {
      await createSource(
        second.id,
        {
          kind: "reddit_account",
          handleUrl: `https://www.reddit.com/user/${handle}`,
          autoImport: true,
          backfillTargetSince: deepTarget,
        },
        "127.0.0.1",
      );
    };
    // The current pass proves coverage only to 7d. It crosses that bound while the
    // provider still advertises another page, which schedules the recursive 30d walk.
    provider.pages = [walkPage([makePost(`c${uniq()}`, 8, handle)], "older-page")];
    // Crash only the recursive fetch. If its durable outbox intent was already marked
    // forwarded by the shallow pass, no worker can recover the missing 30d coverage.
    provider.errors = [null, new Error("scripted recursive crash")];

    await expect(
      handleBackfillAccount({
        data: {
          kind: "reddit_account",
          channelKey: handle,
          triggerUserId: first.id,
          depthBoundIso: shallowTarget.toISOString(),
          flow: "initial",
        },
      }),
    ).rejects.toThrow("scripted recursive crash");

    const intents = await pendingIntents(handle);
    const deepIntent = intents.find((row) => row.payload.triggerUserId === second.id);
    expect(
      deepIntent!.forwarded_at,
      "the deeper intent remains durable until a pass actually covers its target",
    ).toBeNull();
  });
});

// Migration 0073 (reddit legacy source raze) — behavior of the SHIPPED SQL file.
//
// The legacy free-`.json` Reddit adapter stored walk keys as metadata
// {username}/{subreddit}; the rebuilt walker reads {handle}/{slug}, so retained rows
// would resolve a garbage channelKey (their own UUID), burn a credit on an empty
// author-search and flag needs_reconnect forever. Operator call (2026-07-22): the
// migration DELETEs the legacy sources + their channel-state; diary events SURVIVE by
// detaching (events.source_id is ON DELETE SET NULL).
//
// Executes the real drizzle/0073 SQL against seeded legacy-shaped rows (the suite DB
// has already run it at boot, so re-running proves idempotency for free). Real
// Postgres; never mocks the DB.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";
import type { DailyUserRequestAccounting } from "../../src/lib/server/daily-user-quota.js";

let nextPage: RedditFeedPage | null = null;
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
        if (nextPage === null) throw new Error("missing scripted Reddit page");
        const page = nextPage;
        nextPage = null;
        return page;
      },
    };
  },
);

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-account.js");

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0073_reddit_legacy_source_raze.sql"),
  "utf-8",
);

async function runMigration(): Promise<void> {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed !== "") await db.execute(sql.raw(trimmed));
  }
}

const uniq = (): string => Math.random().toString(36).slice(2, 8);

describe("migration 0073 — legacy reddit source raze", () => {
  it("deletes legacy reddit sources + channel-state; events detach (source_id NULL) and survive; non-reddit untouched; idempotent", async () => {
    const u = await seedUserDirectly({ email: `rdt-raze-${uniq()}@t.io` });
    const legacyHandle = `legacy_${uniq()}`;

    // A LEGACY-shaped account source (old metadata key `username`, no channel_id).
    const [redditSrc] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${legacyHandle}`,
        metadata: { username: legacyHandle },
      })
      .returning({ id: dataSources.id });
    // A non-reddit source that MUST survive.
    const [ytSrc] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@keep-me",
        channelId: `UC${uniq()}`,
      })
      .returning({ id: dataSources.id });
    // A diary event imported from the legacy source (t3-prefixed — same as the new tree).
    const externalId = `t3_${uniq()}`;
    const [ev] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: redditSrc!.id,
        kind: "reddit_post",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        title: "legacy import",
        externalId,
      })
      .returning({ id: events.id });
    // Legacy walker bookkeeping that must not leak into the rebuilt walker.
    await db
      .insert(dataSourceChannelState)
      .values({ kind: "reddit_account", channelKey: legacyHandle })
      .onConflictDoNothing();

    await runMigration();

    const [goneSrc] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, redditSrc!.id));
    expect(goneSrc, "legacy reddit source deleted").toBeUndefined();
    const [keptYt] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, ytSrc!.id));
    expect(keptYt, "non-reddit source untouched").toBeDefined();
    const [keptEv] = await db
      .select({ sourceId: events.sourceId, title: events.title })
      .from(events)
      .where(eq(events.id, ev!.id));
    expect(keptEv, "diary event survives").toBeDefined();
    expect(keptEv!.sourceId, "event detached via ON DELETE SET NULL").toBeNull();
    const [goneState] = await db
      .select({ channelKey: dataSourceChannelState.channelKey })
      .from(dataSourceChannelState)
      .where(eq(dataSourceChannelState.channelKey, legacyHandle));
    expect(goneState, "legacy channel-state deleted").toBeUndefined();

    // Forward-only migrations must be safe to re-run against an already-razed DB.
    await runMigration();
    const [stillEv] = await db.select({ id: events.id }).from(events).where(eq(events.id, ev!.id));
    expect(stillEv, "idempotent re-run keeps the detached event").toBeDefined();

    const [rebuiltSource] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${legacyHandle}`,
        channelId: legacyHandle,
        autoImport: true,
        metadata: { handle: legacyHandle },
      })
      .returning({ id: dataSources.id });
    const shortId = externalId.slice(3);
    nextPage = {
      posts: [
        {
          id: externalId,
          kind: "text",
          mediaType: "self",
          publishedAt: new Date("2026-01-01T00:00:00Z"),
          metrics: { views: null, likes: 1, comments: 0, shares: null },
          caption: "legacy body",
          thumbnailUrl: null,
          permalink: `/user/${legacyHandle}/comments/${shortId}/legacy/`,
          title: "legacy import",
          selftext: "legacy body",
          subredditSlug: null,
          author: legacyHandle,
          authorFullname: "t2_legacy",
          raw: {
            score: 1,
            upvoteRatio: null,
            numComments: 0,
            numCrossposts: null,
            removedByCategory: null,
          },
        },
      ],
      nextCursor: null,
      endOfFeed: true,
      creditsUsed: 1,
      owner: null,
      droppedCount: 0,
    };

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: legacyHandle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
        triggerUserId: u.id,
      },
    });

    const matching = await db
      .select({ id: events.id, sourceId: events.sourceId })
      .from(events)
      .where(eq(events.externalId, externalId));
    expect(matching, "first rebuilt walk must reattach, not duplicate").toHaveLength(1);
    expect(matching[0]!.id).toBe(ev!.id);
    expect(matching[0]!.sourceId).toBe(rebuiltSource!.id);
  });
});

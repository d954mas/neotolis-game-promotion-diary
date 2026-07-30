// Migration 0073 (reddit legacy raze) — behavior of the SHIPPED SQL file.
//
// The legacy free-`.json` Reddit adapter keyed events on the BARE base36 post id and
// stored walk keys as metadata {username}/{subreddit}; the rebuilt ScrapeCreators tree
// keys events on the `t3_<id>` fullname and reads {handle}/{slug}. A retained legacy row
// therefore joins nothing in the new cache (no stats/thumbnail/media-type, forever) and a
// retained source resolves a garbage channelKey (its own UUID) that burns a credit on an
// empty author-search and flags needs_reconnect forever.
//
// The project owner approved a FULL destructive reset (2026-07-26): the migration DELETEs
// the legacy reddit_post events, the reddit sources and their channel-state. Users re-add
// their Reddit sources; the rebuilt walker re-imports fresh, cache-joined events. The old
// CACHE tables were already dropped by 0070 (nothing left to delete here).
//
// Executes the real drizzle/0073 SQL against seeded legacy-shaped rows (the suite DB has
// already run it at boot, so re-running proves idempotency for free). Real Postgres;
// never mocks the DB.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
const { games } = await import("../../src/lib/server/db/schema/games.js");
const { eventGames } = await import("../../src/lib/server/db/schema/event-games.js");
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

describe("migration 0073 — legacy reddit raze (full destructive reset)", () => {
  it("deletes legacy reddit events + sources + channel-state; other platforms untouched; idempotent", async () => {
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
    // A LEGACY-shaped subreddit source (old metadata key `subreddit`, no channel_id) —
    // the raze targets BOTH reddit kinds; account fixtures alone would stay green if the
    // shape discriminator only handled `handle`.
    const legacySlug = `legacysub_${uniq()}`;
    const [redditSubSrc] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_subreddit",
        handleUrl: `https://www.reddit.com/r/${legacySlug}`,
        metadata: { subreddit: legacySlug },
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
    // A legacy diary event with the legacy BARE-id external_id (the shape that can never
    // join the rebuilt t3_-keyed cache) + a game attachment (FK cascade must not error).
    const legacyBareId = uniq();
    const legacyFullId = `t3_${legacyBareId}`;
    const [ev] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: redditSrc!.id,
        kind: "reddit_post",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        title: "legacy import",
        externalId: legacyBareId,
      })
      .returning({ id: events.id });
    // The shipped legacy pollers already wrote fullnames too. This is the load-bearing
    // upgrade shape: if it survives while the source is deleted, ON DELETE SET NULL
    // detaches it and the rebuilt walker later imports a duplicate with the same t3_ id.
    const [legacyFullnameEv] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: redditSrc!.id,
        kind: "reddit_post",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        title: "legacy fullname import",
        externalId: legacyFullId,
      })
      .returning({ id: events.id });
    // A t3_-keyed event on the legacy SUBREDDIT source. Its deletion rides ENTIRELY on
    // the metadata-shape discriminator recognizing {subreddit:…} as legacy — a typo like
    // `? 'slug'` → `? 'subreddit'` there would keep this row (and its source) alive.
    const [legacySubEv] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: redditSubSrc!.id,
        kind: "reddit_post",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        title: "legacy subreddit import",
        externalId: `t3_${uniq()}`,
      })
      .returning({ id: events.id });
    const [game] = await db
      .insert(games)
      .values({ userId: u.id, title: `raze-game-${uniq()}` })
      .returning({ id: games.id });
    await db
      .insert(eventGames)
      .values({ userId: u.id, eventId: ev!.id, gameId: game!.id })
      .onConflictDoNothing();
    // A MANUALLY pasted reddit event (no source) — also razed: the owner approved the
    // full reset, and a bare-id manual paste has the same never-joins-the-cache problem.
    const [manualEv] = await db
      .insert(events)
      .values({
        userId: u.id,
        kind: "reddit_post",
        occurredAt: new Date("2026-01-02T00:00:00Z"),
        title: "manual legacy paste",
        externalId: uniq(),
      })
      .returning({ id: events.id });
    // A non-reddit event that MUST survive.
    const [ytEv] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: ytSrc!.id,
        kind: "youtube_video",
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        title: "keep me",
        externalId: `yt_${uniq()}`,
      })
      .returning({ id: events.id });
    // Legacy walker bookkeeping that must not leak into the rebuilt walker.
    await db
      .insert(dataSourceChannelState)
      .values({ kind: "reddit_account", channelKey: legacyHandle })
      .onConflictDoNothing();
    await db
      .insert(dataSourceChannelState)
      .values({ kind: "reddit_subreddit", channelKey: legacySlug })
      .onConflictDoNothing();

    await runMigration();

    const [goneSrc] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, redditSrc!.id));
    expect(goneSrc, "legacy reddit source deleted").toBeUndefined();
    const [goneEv] = await db.select({ id: events.id }).from(events).where(eq(events.id, ev!.id));
    expect(goneEv, "legacy reddit event deleted (not merely detached)").toBeUndefined();
    const [goneFullnameEv] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, legacyFullnameEv!.id));
    expect(goneFullnameEv, "legacy t3_-keyed event deleted (not merely detached)").toBeUndefined();
    const [goneSubSrc] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, redditSubSrc!.id));
    expect(goneSubSrc, "legacy reddit_subreddit source deleted").toBeUndefined();
    const [goneSubEv] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, legacySubEv!.id));
    expect(goneSubEv, "legacy subreddit t3_-keyed event deleted").toBeUndefined();
    const [goneManual] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, manualEv!.id));
    expect(goneManual, "manually pasted legacy reddit event deleted too").toBeUndefined();
    const attachments = await db
      .select({ eventId: eventGames.eventId })
      .from(eventGames)
      .where(eq(eventGames.userId, u.id));
    expect(attachments, "event_games cascaded with the deleted event").toHaveLength(0);

    const [keptYt] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, ytSrc!.id));
    expect(keptYt, "non-reddit source untouched").toBeDefined();
    const [keptYtEv] = await db
      .select({ id: events.id, sourceId: events.sourceId })
      .from(events)
      .where(eq(events.id, ytEv!.id));
    expect(keptYtEv, "non-reddit event untouched").toBeDefined();
    expect(keptYtEv!.sourceId, "non-reddit event keeps its source").toBe(ytSrc!.id);

    const [goneState] = await db
      .select({ channelKey: dataSourceChannelState.channelKey })
      .from(dataSourceChannelState)
      .where(eq(dataSourceChannelState.channelKey, legacyHandle));
    expect(goneState, "legacy channel-state deleted").toBeUndefined();
    const [goneSubState] = await db
      .select({ channelKey: dataSourceChannelState.channelKey })
      .from(dataSourceChannelState)
      .where(eq(dataSourceChannelState.channelKey, legacySlug));
    expect(goneSubState, "legacy subreddit channel-state deleted").toBeUndefined();

    // Forward-only migrations must be safe to re-run against an already-razed DB.
    await runMigration();
    const [stillYtEv] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, ytEv!.id));
    expect(stillYtEv, "idempotent re-run keeps the non-reddit event").toBeDefined();

    // After the reset, a re-added source + the first rebuilt walk import the post FRESH,
    // keyed on the t3_ fullname the new cache joins on — one event, no legacy duplicate.
    const [rebuiltSource] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${legacyHandle}`,
        channelId: legacyHandle,
        isOwnedByMe: true,
        autoImport: true,
        metadata: { handle: legacyHandle },
      })
      .returning({ id: dataSources.id });
    const externalId = legacyFullId;
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
          permalink: `/user/${legacyHandle}/comments/${legacyBareId}/legacy/`,
          title: "legacy import",
          selftext: "legacy body",
          linkDomain: null,
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
    expect(matching, "the rebuilt walk imports exactly one t3_-keyed event").toHaveLength(1);
    expect(matching[0]!.sourceId).toBe(rebuiltSource!.id);
  });
  // REGRESSION (review): the migration used to be scoped by KIND alone, so its
  // predicates matched the REBUILT tree's rows exactly as well as the legacy ones. The
  // header claimed idempotency, but that reasoning was "it only ever runs once" — and
  // this repo has already needed a repair migration that re-executed skipped work
  // (0062). A second execution would then have wiped every Reddit source and event the
  // rebuilt walker had imported. The predicates now additionally match the LEGACY SHAPE.
  it("[review] re-running the migration does NOT touch rebuilt-tree rows", async () => {
    const u = await seedUserDirectly({ email: `rdt-raze-idem-${uniq()}@t.io` });
    const handle = `rebuilt_${uniq()}`;

    // A REBUILT-shape source (metadata {handle}, channel_id set) + its channel state.
    const [src] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${handle}`,
        channelId: handle,
        metadata: { handle },
      })
      .returning({ id: dataSources.id });
    await db
      .insert(dataSourceChannelState)
      .values({ kind: "reddit_account", channelKey: handle })
      .onConflictDoNothing();
    // A REBUILT-shape event (t3_-keyed), both source-linked and hand-pasted.
    const t3 = `t3_${uniq()}`;
    await db.insert(events).values({
      userId: u.id,
      sourceId: src!.id,
      kind: "reddit_post",
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      title: "imported by the rebuilt walker",
      externalId: t3,
    });
    const pastedT3 = `t3_${uniq()}`;
    await db.insert(events).values({
      userId: u.id,
      kind: "reddit_post",
      occurredAt: new Date("2026-07-02T00:00:00Z"),
      title: "pasted after the upgrade",
      externalId: pastedT3,
    });
    // A REBUILT-shape SUBREDDIT source (metadata {slug}, channel_id set) + channel state
    // + a t3_-keyed event. The shape discriminator must recognize `slug` as rebuilt — a
    // typo like `? 'slug'` → `? 'subreddit'` would wipe all three on a re-run.
    const slug = `rebuiltsub_${uniq()}`;
    const [subSrc] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "reddit_subreddit",
        handleUrl: `https://www.reddit.com/r/${slug}`,
        channelId: slug,
        metadata: { slug },
      })
      .returning({ id: dataSources.id });
    await db
      .insert(dataSourceChannelState)
      .values({ kind: "reddit_subreddit", channelKey: slug })
      .onConflictDoNothing();
    const subT3 = `t3_${uniq()}`;
    await db.insert(events).values({
      userId: u.id,
      sourceId: subSrc!.id,
      kind: "reddit_post",
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      title: "imported by the rebuilt subreddit walker",
      externalId: subT3,
    });

    await runMigration();
    await runMigration();

    const survivingSources = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, src!.id));
    expect(survivingSources, "a rebuilt-shape source must survive a re-run").toHaveLength(1);
    const survivingSubSources = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.id, subSrc!.id));
    expect(
      survivingSubSources,
      "a rebuilt-shape subreddit source must survive a re-run",
    ).toHaveLength(1);

    for (const id of [t3, pastedT3, subT3]) {
      const rows = await db.select({ id: events.id }).from(events).where(eq(events.externalId, id));
      expect(rows, `a rebuilt-shape event (${id}) must survive a re-run`).toHaveLength(1);
    }

    const state = await db
      .select({ channelKey: dataSourceChannelState.channelKey })
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "reddit_account"),
          eq(dataSourceChannelState.channelKey, handle),
        ),
      );
    expect(state, "channel state with a live source must survive a re-run").toHaveLength(1);
    const subState = await db
      .select({ channelKey: dataSourceChannelState.channelKey })
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "reddit_subreddit"),
          eq(dataSourceChannelState.channelKey, slug),
        ),
      );
    expect(
      subState,
      "subreddit channel state with a live source must survive a re-run",
    ).toHaveLength(1);
  });
});

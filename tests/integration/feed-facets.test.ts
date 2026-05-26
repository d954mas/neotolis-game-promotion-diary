import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createEvent,
  listFeedFacets,
  OFF_TOPIC_TAG,
  type FeedFilters,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

// Helper: flip metadata.triage.offTopic on an owned event row directly,
// bypassing the (now-deleted) markStandalone service. The off-topic write
// path proper goes through bulkEdit; here we only need the post-state to
// seed listFeedFacets fixtures.
async function setOffTopicDirectly(userId: string, eventId: string): Promise<void> {
  await db
    .update(events)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(
          COALESCE(${events.metadata}, '{}'::jsonb),
          '{triage}',
          COALESCE(${events.metadata}->'triage', '{}'::jsonb),
          true
        ),
        '{triage,offTopic}',
        'true'::jsonb,
        true
      )`,
    })
    .where(and(eq(events.userId, userId), eq(events.id, eventId)));
}

/**
 * listFeedFacets — server-side facet counts (Plan 03.4-10 follow-up Option B).
 *
 * Contract anchors:
 *   - GAME facet count is STABLE when other GAME chips are toggled
 *     (excludes its own axis from the base WHERE).
 *   - KIND facet count is STABLE when other KIND chips are toggled.
 *   - SHOW (inbox) count = inbox-eligible events regardless of GAME / KIND
 *     toggles on top of the base axes.
 *   - AUTHOR (mine / others) counts are STABLE when other AUTHOR chips
 *     are toggled.
 *   - off_topic sentinel count is stable when game chips toggle.
 *   - Total / gameTagsAll / kindsAll sentinel counts match expectations.
 *   - Tenant-scoped — facets never include another user's events.
 */

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedUserWithFixtures(prefix: string): Promise<{
  userId: string;
  game1: string;
  game2: string;
  // Event IDs by purpose:
  yt1: string; // youtube_video, mine, attached to game1
  yt2: string; // youtube_video, mine, attached to game2
  reddit1: string; // reddit_post, others, attached to game1 + game2
  press1: string; // press, mine, inbox (no games)
  press2: string; // press, others, off-topic (no games, triage.offTopic=true)
}> {
  const u = await seedUserDirectly({ email: `facets-${prefix}-${uniq()}@test.local` });
  const game1 = uuidv7();
  const game2 = uuidv7();
  await db.insert(games).values({ id: game1, userId: u.id, title: `Last Light ${uniq()}` });
  await db.insert(games).values({ id: game2, userId: u.id, title: `Dungeon ${uniq()}` });

  const yt1 = await createEvent(
    u.id,
    {
      gameIds: [game1],
      kind: "youtube_video",
      occurredAt: new Date("2026-05-15T10:00:00Z"),
      title: `yt1 ${uniq()}`,
      authorIsMe: true,
    },
    "127.0.0.1",
  );
  const yt2 = await createEvent(
    u.id,
    {
      gameIds: [game2],
      kind: "youtube_video",
      occurredAt: new Date("2026-05-15T11:00:00Z"),
      title: `yt2 ${uniq()}`,
      authorIsMe: true,
    },
    "127.0.0.1",
  );
  const reddit1 = await createEvent(
    u.id,
    {
      gameIds: [game1, game2],
      kind: "reddit_post",
      occurredAt: new Date("2026-05-15T12:00:00Z"),
      title: `reddit1 ${uniq()}`,
      authorIsMe: false,
    },
    "127.0.0.1",
  );
  const press1 = await createEvent(
    u.id,
    {
      gameIds: [],
      kind: "press",
      occurredAt: new Date("2026-05-15T13:00:00Z"),
      title: `press1 ${uniq()}`,
      authorIsMe: true,
    },
    "127.0.0.1",
  );
  const press2 = await createEvent(
    u.id,
    {
      gameIds: [],
      kind: "press",
      occurredAt: new Date("2026-05-15T14:00:00Z"),
      title: `press2 ${uniq()}`,
      authorIsMe: false,
    },
    "127.0.0.1",
  );
  // Mark press2 off-topic so it leaves the inbox AND surfaces under the
  // off_topic facet bucket.
  await setOffTopicDirectly(u.id, press2.id);

  return {
    userId: u.id,
    game1,
    game2,
    yt1: yt1.id,
    yt2: yt2.id,
    reddit1: reddit1.id,
    press1: press1.id,
    press2: press2.id,
  };
}

function emptyFilters(): FeedFilters {
  return {};
}

describe("listFeedFacets (Plan 03.4-10 follow-up Option B)", () => {
  it("GAME facet — each chip count reflects events attached to that game, stable across same-axis toggles", async () => {
    const fx = await seedUserWithFixtures("game-stable");

    // Baseline: no game tags selected. Last Light (game1) = yt1 + reddit1 = 2;
    // Dungeon (game2) = yt2 + reddit1 = 2; off_topic = press2 = 1.
    const baseFacets = await listFeedFacets(fx.userId, emptyFilters());
    expect(baseFacets.gameTags[fx.game1]).toBe(2);
    expect(baseFacets.gameTags[fx.game2]).toBe(2);
    expect(baseFacets.gameTags[OFF_TOPIC_TAG]).toBe(1);

    // Select Last Light alone — the GAME facet excludes its own axis, so
    // Last Light's count MUST stay 2 (not collapse to the OR-of-self count).
    const withGame1 = await listFeedFacets(fx.userId, { gameTags: [fx.game1] });
    expect(withGame1.gameTags[fx.game1]).toBe(2);
    expect(withGame1.gameTags[fx.game2]).toBe(2);
    expect(withGame1.gameTags[OFF_TOPIC_TAG]).toBe(1);

    // Select both — same stability invariant. No same-axis chip count changes
    // when chips on this axis are toggled.
    const withBoth = await listFeedFacets(fx.userId, { gameTags: [fx.game1, fx.game2] });
    expect(withBoth.gameTags[fx.game1]).toBe(2);
    expect(withBoth.gameTags[fx.game2]).toBe(2);
    expect(withBoth.gameTags[OFF_TOPIC_TAG]).toBe(1);
  });

  it("GAME facet — recomputes when OTHER axes (kind) change", async () => {
    const fx = await seedUserWithFixtures("game-responsive");

    // Restrict to kind=youtube_video. Last Light has yt1 only; Dungeon has
    // yt2 only; reddit1 (which attached both) drops out of the bucket.
    const ytOnly = await listFeedFacets(fx.userId, { kind: "youtube_video" });
    expect(ytOnly.gameTags[fx.game1]).toBe(1);
    expect(ytOnly.gameTags[fx.game2]).toBe(1);
    // off_topic press2 is a press kind — drops out under kind=youtube_video.
    expect(ytOnly.gameTags[OFF_TOPIC_TAG] ?? 0).toBe(0);
  });

  it("KIND facet — stable across same-axis toggles, responsive to other axes", async () => {
    const fx = await seedUserWithFixtures("kind-stable");

    // Baseline: youtube_video = yt1 + yt2 = 2, reddit_post = reddit1 = 1,
    // press = press1 + press2 = 2.
    const baseFacets = await listFeedFacets(fx.userId, emptyFilters());
    expect(baseFacets.kinds["youtube_video"]).toBe(2);
    expect(baseFacets.kinds["reddit_post"]).toBe(1);
    expect(baseFacets.kinds["press"]).toBe(2);

    // Restrict kind=reddit_post — youtube_video chip count MUST stay 2
    // (excludes its own axis).
    const reddit = await listFeedFacets(fx.userId, { kind: "reddit_post" });
    expect(reddit.kinds["youtube_video"]).toBe(2);
    expect(reddit.kinds["reddit_post"]).toBe(1);
    expect(reddit.kinds["press"]).toBe(2);

    // Restrict author=mine — youtube_video stays 2 (yt1 + yt2 both mine);
    // reddit_post drops to 0 (reddit1 is others); press drops to 1 (only press1).
    const mineOnly = await listFeedFacets(fx.userId, { authorIsMe: true });
    expect(mineOnly.kinds["youtube_video"]).toBe(2);
    expect(mineOnly.kinds["reddit_post"] ?? 0).toBe(0);
    expect(mineOnly.kinds["press"]).toBe(1);
  });

  it("SHOW (inbox) facet — counts events in the inbox-eligible state regardless of same-axis state", async () => {
    const fx = await seedUserWithFixtures("show-inbox");

    // Inbox criterion: zero attached games AND not dismissed AND not off-topic.
    // From the fixture: press1 qualifies. press2 is off-topic → excluded.
    // yt1/yt2/reddit1 all have games attached → excluded.
    const facets = await listFeedFacets(fx.userId, emptyFilters());
    expect(facets.show.inbox).toBe(1);

    // When show=inbox is already active, the inbox chip count MUST stay 1
    // (excludes its own axis from the base).
    const inboxActive = await listFeedFacets(fx.userId, { show: { kind: "inbox" } });
    expect(inboxActive.show.inbox).toBe(1);

    // The "all" sentinel under show=inbox reflects the SHOW-excluded base —
    // every event matches (5 fixtures total).
    expect(inboxActive.show.all).toBe(5);
  });

  it("AUTHOR facet — stable per chip; mine/others split correctly", async () => {
    const fx = await seedUserWithFixtures("author");

    // Baseline: mine = yt1 + yt2 + press1 = 3; others = reddit1 + press2 = 2;
    // anyone = 5.
    const baseFacets = await listFeedFacets(fx.userId, emptyFilters());
    expect(baseFacets.author.mine).toBe(3);
    expect(baseFacets.author.others).toBe(2);
    expect(baseFacets.author.anyone).toBe(5);

    // Select author=mine — chip counts MUST stay the same (excludes own axis).
    const mine = await listFeedFacets(fx.userId, { authorIsMe: true });
    expect(mine.author.mine).toBe(3);
    expect(mine.author.others).toBe(2);
    expect(mine.author.anyone).toBe(5);
  });

  it("total = events matching ALL axes; gameTagsAll / kindsAll exclude their own axes", async () => {
    const fx = await seedUserWithFixtures("totals");

    const baseFacets = await listFeedFacets(fx.userId, emptyFilters());
    expect(baseFacets.total).toBe(5);
    expect(baseFacets.gameTagsAll).toBe(5);
    expect(baseFacets.kindsAll).toBe(5);

    // Narrow to kind=press: total = 2 (press1 + press2). gameTagsAll still
    // restricts to press (kind axis still applied) but excludes GAME axis →
    // 2. kindsAll excludes KIND axis → 5.
    const press = await listFeedFacets(fx.userId, { kind: "press" });
    expect(press.total).toBe(2);
    expect(press.gameTagsAll).toBe(2);
    expect(press.kindsAll).toBe(5);

    // Add gameTags=[game1] on top: total = events matching kind=press AND
    // (game1 OR ...). press1 has no games; press2 is off-topic (not game1).
    // So neither press event passes — total = 0. gameTagsAll excludes
    // gameTags → 2 (the two press events). kindsAll excludes kind →
    // events matching gameTags=[game1] = yt1 + reddit1 = 2.
    const pressGame1 = await listFeedFacets(fx.userId, {
      kind: "press",
      gameTags: [fx.game1],
    });
    expect(pressGame1.total).toBe(0);
    expect(pressGame1.gameTagsAll).toBe(2);
    expect(pressGame1.kindsAll).toBe(2);
  });

  it("user reported bug — Last Light chip stays at same number after clicking it", async () => {
    // Reproduces the «Last Light chip showed 2 before clicking, then 4 after
    // clicking» bug. With server-side facets the count MUST stay 2 across
    // the toggle.
    const fx = await seedUserWithFixtures("user-bug");

    const before = await listFeedFacets(fx.userId, emptyFilters());
    const before_g1 = before.gameTags[fx.game1];
    expect(before_g1).toBe(2);

    const after = await listFeedFacets(fx.userId, { gameTags: [fx.game1] });
    const after_g1 = after.gameTags[fx.game1];
    expect(after_g1).toBe(before_g1);
  });

  it("tenant-scoped — never returns another user's facet counts", async () => {
    const fx = await seedUserWithFixtures("tenant-mine");
    const fxOther = await seedUserWithFixtures("tenant-other");

    const mine = await listFeedFacets(fx.userId, emptyFilters());
    expect(mine.total).toBe(5);
    expect(mine.gameTags[fx.game1]).toBe(2);
    // Other tenant's game ID must NOT appear in our facet output.
    expect(mine.gameTags[fxOther.game1]).toBeUndefined();
    expect(mine.gameTags[fxOther.game2]).toBeUndefined();
  });
});

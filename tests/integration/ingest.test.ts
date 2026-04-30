import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { parsePasteAndCreate } from "../../src/lib/server/services/ingest.js";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import * as YT from "../../src/lib/server/integrations/youtube-oembed.js";
import * as TW from "../../src/lib/server/integrations/twitter-oembed.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Phase 2.1 Wave 1B (Plan 02.1-05) — INGEST-02..04 reframed under unified events.
 *
 * The Phase 2 ingest path wrote a row to `tracked_youtube_videos`. Phase 2.1
 * collapses that into ONE `events` row (kind=youtube_video) carrying source_id
 * (NULL on no match) + author_is_me (false on no match). This test file is
 * the contract: the items-youtube service is gone, and a YouTube paste
 * produces exactly one events row.
 *
 * Mocking strategy: vi.spyOn(YT, 'fetchYoutubeOembed') and the same against
 * twitter-oembed. ESM partial mocks via vi.mock are flaky on @sveltejs/kit +
 * Vitest 4; spyOn against `import * as` mirrors the Phase 2 precedent.
 *
 * D-19 / AGENTS.md "validate-first INGEST" verification: every test exercising
 * a 422 / 502 failure asserts ZERO rows in `events` after the failure — no
 * half-write.
 */
describe("URL ingest paste-box (INGEST-02..04 — unified events)", () => {
  const ytSpy = vi.spyOn(YT, "fetchYoutubeOembed");
  const twSpy = vi.spyOn(TW, "fetchTwitterOembed");
  afterEach(() => {
    ytSpy.mockReset();
    twSpy.mockReset();
  });

  it("INGEST-02: YouTube paste creates events row (kind=youtube_video, source_id=NULL on no match)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        authorUrl: "https://www.youtube.com/@RickAstleyYT",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    });
    const u = await seedUserDirectly({ email: "ing1@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const r = await parsePasteAndCreate(
      u.id,
      gameId,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "127.0.0.1",
    );
    expect(r.kind).toBe("event_created");

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("youtube_video");
    expect(row.title).toBe("Never Gonna Give You Up");
    expect(row.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(row.externalId).toBe("dQw4w9WgXcQ");
    // No registered data_source matches → source_id NULL, author_is_me false.
    expect(row.sourceId).toBeNull();
    expect(row.authorIsMe).toBe(false);
    // Plan 02.1-28: gameId column gone; verify the junction has the gameId.
    const { eventGames: eg28 } = await import("../../src/lib/server/db/schema/event-games.js");
    const { and: and28, eq: eq28 } = await import("drizzle-orm");
    const junction = await db
      .select()
      .from(eg28)
      .where(and28(eq28(eg28.userId, u.id), eq28(eg28.eventId, row.id)));
    expect(junction.map((r) => r.gameId)).toEqual([gameId]);
    const meta = row.metadata as { author_url?: string; author_name?: string };
    expect(meta.author_url).toBe("https://www.youtube.com/@RickAstleyYT");
    expect(meta.author_name).toBe("Rick Astley");
  });

  it("INGEST-03: YouTube paste with author_url matching registered data_source (is_owned_by_me=true) sets author_is_me=true and source_id=:source", async () => {
    const u = await seedUserDirectly({ email: "ing2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const sourceId = uuidv7();
    await db.insert(dataSources).values({
      id: sourceId,
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://www.youtube.com/@MyOwn",
      displayName: "My Own Channel",
      isOwnedByMe: true,
      autoImport: true,
    });

    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "My own video",
        authorName: "MyOwn",
        authorUrl: "https://www.youtube.com/@MyOwn",
        thumbnailUrl: "",
      },
    });

    await parsePasteAndCreate(
      u.id,
      gameId,
      "https://www.youtube.com/watch?v=ABC12345678",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sourceId).toBe(sourceId);
    expect(row.authorIsMe).toBe(true);
    expect(row.kind).toBe("youtube_video");
  });

  it("INGEST-03: YouTube paste with no author_url match keeps author_is_me=false and source_id=NULL", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Some blogger",
        authorName: "Blogger",
        authorUrl: "https://www.youtube.com/@SomeBlogger",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "ing3@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    // Pre-register a DIFFERENT source — should NOT match.
    await db.insert(dataSources).values({
      id: uuidv7(),
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://www.youtube.com/@MyOwn",
      isOwnedByMe: true,
      autoImport: true,
    });

    await parsePasteAndCreate(
      u.id,
      gameId,
      "https://www.youtube.com/watch?v=tog12345678",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceId).toBeNull();
    expect(rows[0]!.authorIsMe).toBe(false);
  });

  it("INGEST-03: YouTube paste with author_url matching a soft-deleted source does NOT inherit (deletedAt filter)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "T",
        authorName: "A",
        authorUrl: "https://www.youtube.com/@DeadSource",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "ing3b@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    await db.insert(dataSources).values({
      id: uuidv7(),
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://www.youtube.com/@DeadSource",
      isOwnedByMe: true,
      autoImport: true,
      deletedAt: new Date(),
    });

    await parsePasteAndCreate(
      u.id,
      gameId,
      "https://www.youtube.com/watch?v=ded12345678",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows[0]!.sourceId).toBeNull();
    expect(rows[0]!.authorIsMe).toBe(false);
  });

  it("INGEST-04: malformed URL returns 422 unsupported_url; NO row inserted (validate-first)", async () => {
    const u = await seedUserDirectly({ email: "ing4@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    await expect(parsePasteAndCreate(u.id, gameId, "not-a-url", "127.0.0.1")).rejects.toMatchObject(
      { status: 422, code: "unsupported_url" },
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("INGEST-04: oEmbed 5xx returns 502 youtube_oembed_unreachable; NO row inserted", async () => {
    ytSpy.mockRejectedValue(new Error("youtube_oembed_5xx"));
    const u = await seedUserDirectly({ email: "ing5@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    await expect(
      parsePasteAndCreate(u.id, gameId, "https://www.youtube.com/watch?v=ABC12345678", "127.0.0.1"),
    ).rejects.toMatchObject({ status: 502, code: "youtube_oembed_unreachable" });

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("INGEST-04: oEmbed 404 unavailable returns 422 youtube_unavailable; NO row inserted", async () => {
    ytSpy.mockResolvedValue({ kind: "unavailable" });
    const u = await seedUserDirectly({ email: "ing5b@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    await expect(
      parsePasteAndCreate(u.id, gameId, "https://www.youtube.com/watch?v=ABC12345678", "127.0.0.1"),
    ).rejects.toMatchObject({
      status: 422,
      code: "youtube_unavailable",
      metadata: { reason: "unavailable" },
    });

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("INGEST-04: Reddit paste returns 422 reddit_pending_phase3 — no row inserted (CONTEXT DV-7)", async () => {
    const u = await seedUserDirectly({ email: "ing6@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    await expect(
      parsePasteAndCreate(
        u.id,
        gameId,
        "https://www.reddit.com/r/IndieDev/comments/abc/foo/",
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ status: 422, code: "reddit_pending_phase3" });

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("Twitter paste creates events row kind=twitter_post (carry-forward Phase 2 behavior)", async () => {
    twSpy.mockResolvedValue({
      authorName: "Anna Indie",
      authorHandle: "AnnaIndie",
      html: "<blockquote>Tweet body</blockquote>",
    });
    const u = await seedUserDirectly({ email: "ing7@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const r = await parsePasteAndCreate(
      u.id,
      gameId,
      "https://twitter.com/AnnaIndie/status/12345",
      "127.0.0.1",
    );
    expect(r.kind).toBe("event_created");

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("twitter_post");
    expect(row.url).toBe("https://twitter.com/AnnaIndie/status/12345");
    expect(row.title).toContain("Anna Indie");
    expect(row.notes).toContain("Tweet body");
  });

  it("YouTube paste with gameId=null lands in inbox (inbox-first IA)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Manual paste",
        authorName: "Anyone",
        authorUrl: "https://www.youtube.com/@Anyone",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "ing8@test.local" });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=inb12345678",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    // Plan 02.1-28: inbox criterion is "zero junction rows" — verify the
    // event has no event_games attachments.
    const { eventGames: eg28 } = await import("../../src/lib/server/db/schema/event-games.js");
    const { and: and28, eq: eq28 } = await import("drizzle-orm");
    const junction = await db
      .select()
      .from(eg28)
      .where(and28(eq28(eg28.userId, u.id), eq28(eg28.eventId, rows[0]!.id)));
    expect(junction).toHaveLength(0);
  });
});

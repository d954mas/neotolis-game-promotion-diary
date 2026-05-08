import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// Phase 3.0 Plan 10 — channel-context backfill enqueue is exercised in the
// new INGEST-channel-context test block at the bottom of this file. We mock
// pg-boss's `getBoss` (mirrors refresh-poll-cooldown.test.ts / refresh-now.test.ts)
// so this test doesn't depend on a live boss schema. The mock is hoisted by
// vitest, so the existing top-level static imports below remain valid.
const sentJobs: Array<{
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (
        queue: string,
        data: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        sentJobs.push({ queue, data, options });
        return "mock-job-id";
      },
    }),
  };
});

import { parsePasteAndCreate } from "../../src/lib/server/services/ingest.js";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { youtubeChannels } from "../../src/lib/server/db/schema/youtube-channels.js";
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

/**
 * Phase 3.0 Plan 10 — Channel-context backfill trigger (CONTEXT D-14).
 *
 * When the user pastes a YouTube URL via the manual-paste flow and the URL's
 * channel is NOT yet in `youtube_channels`, ingest enqueues ONE
 * `YOUTUBE_CHANNEL_CONTEXT_BACKFILL` job (idempotent via pg-boss singletonKey).
 * Subsequent paste from the same channel = cache hit, no extra quota burn.
 *
 * The handler that processes the backfill job ships in Plan 03.0-09. This
 * test block only verifies the trigger half:
 *   1. Cache miss → exactly ONE enqueue (right queue, right payload, right key)
 *   2. Same-channel double paste during in-flight → second paste does NOT enqueue
 *      (singletonKey gates pg-boss; we assert the dedup at the trigger layer
 *      by recording singletonKey identity across calls)
 *   3. Cache hit → ZERO enqueue
 *   4. Non-YouTube paste (twitter / telegram) → ZERO enqueue
 *   5. oEmbed authorUrl empty (private/unavailable already handled, but a
 *      successful 200 with empty author_url is a real edge case) → event row
 *      still created via Phase 2.1 path; ZERO enqueue (silent skip)
 */
describe("Plan 03.0-10: channel-context backfill trigger (CONTEXT D-14)", () => {
  const ytSpy = vi.spyOn(YT, "fetchYoutubeOembed");
  const twSpy = vi.spyOn(TW, "fetchTwitterOembed");
  beforeEach(() => {
    sentJobs.length = 0;
  });
  afterEach(() => {
    ytSpy.mockReset();
    twSpy.mockReset();
  });

  it("Test 1: paste of YouTube URL with author_url containing /channel/UC… (cache miss) → enqueues YOUTUBE_CHANNEL_CONTEXT_BACKFILL once", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "First paste",
        authorName: "Indie Dev",
        authorUrl: "https://www.youtube.com/channel/UCabcDEFghijKLMnopQRStuv",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-miss@test.local" });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10mis123ab",
      "127.0.0.1",
    );

    // Event row was created (Phase 2.1 contract preserved).
    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);

    // Exactly one enqueue happened, on the right queue, with the right shape.
    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(1);
    const job = enqueues[0]!;
    expect(job.data).toMatchObject({
      channelId: "UCabcDEFghijKLMnopQRStuv",
      userId: u.id,
    });
    // singletonKey contains the channelId so pg-boss dedups concurrent pastes.
    const opts = job.options as { singletonKey?: string };
    expect(opts.singletonKey).toBeTruthy();
    expect(opts.singletonKey).toContain("UCabcDEFghijKLMnopQRStuv");
  });

  it("Test 2: second paste from SAME channel during in-flight backfill → both pastes succeed; both call boss.send with the SAME singletonKey (pg-boss dedup gate)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Same channel video",
        authorName: "Indie Dev",
        authorUrl: "https://www.youtube.com/channel/UCsame12345samesame12345",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-double@test.local" });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10dbl001ab",
      "127.0.0.1",
    );
    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10dbl002ab",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(2);

    // Both pastes hit the cache-miss path (cache table is still empty — the
    // backfill handler is mocked away; it never landed a row). Both pastes
    // therefore call boss.send. The dedup gate is the singletonKey, which
    // pg-boss uses to coalesce; we verify the trigger emits IDENTICAL
    // singletonKeys so pg-boss has the information it needs to dedup. The
    // pg-boss-side coalescing is asserted in Plan 03.0-09's handler tests
    // and / or in the live integration smoke.
    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(2);
    const k1 = (enqueues[0]!.options as { singletonKey?: string }).singletonKey;
    const k2 = (enqueues[1]!.options as { singletonKey?: string }).singletonKey;
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2);
  });

  it("Test 3: paste where channel IS already in youtube_channels → event created; ZERO enqueue (zero extra quota)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Cached channel video",
        authorName: "Cached Dev",
        authorUrl: "https://www.youtube.com/channel/UCcache0123cache0123cach",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-hit@test.local" });

    // Pre-seed the cache for this channel.
    await db.insert(youtubeChannels).values({
      channelId: "UCcache0123cache0123cach",
      uploadsPlaylistId: "UUcache0123cache0123cach",
      channelTitle: "Cached Dev Channel",
      lastBackfillAt: new Date(),
    });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10hit001ab",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(0);
  });

  it("Test 3a: paste where channel matches a handle_aliases entry → event created; ZERO enqueue (handle-URL cache hit)", async () => {
    // Phase 3.0 post-build (2026-05-07) — handle-URL cache miss closure.
    // ingest extracts the raw handle URL as channelId for /@… inputs.
    // Backfill worker resolves the URL → UC and writes the URL into
    // handle_aliases on the existing UC row. This test pins the
    // ingest-side payoff: a paste that matches a row's handle_aliases
    // entry hits the cache and skips the enqueue, just like a UC PK match.
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Aliased handle video",
        authorName: "Handle Dev",
        authorUrl: "https://www.youtube.com/@handle-dev",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-alias@test.local" });

    // Pre-seed the cache: UC row with the handle URL recorded as an alias.
    await db.insert(youtubeChannels).values({
      channelId: "UCalias01alias01alias01a",
      uploadsPlaylistId: "UUalias01alias01alias01a",
      channelTitle: "Handle Dev Channel",
      lastBackfillAt: new Date(),
      handleAliases: ["https://www.youtube.com/@handle-dev"],
    });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10ali001ab",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(0);
  });

  it("Test 3b: paste of YouTube URL with author_url pointing at /@handle (cache miss) → enqueues with HANDLE_URL field, NOT channelId (P1 fix 2026-05-08)", async () => {
    // Regression for the third-pass review's #1 finding. Pre-fix, the
    // ingest extractor returned the full /@handle URL as a string and
    // the caller stuffed it into the job's channelId field. The worker's
    // resolution branch (`if (!channelId && handleUrl)`) skipped because
    // channelId was truthy (the URL string), so it called channels.list?
    // id=<full URL> → no items → silent failure. Every @handle backfill
    // from the ingest path was dead code for months without anyone
    // noticing.
    //
    // The fix made extractChannelIdFromAuthorUrl return a discriminated
    // union {kind:'channelId'|'handleUrl',value} and the caller routes
    // value into the matching job-payload field. This test pins that
    // routing: an @handle authorUrl MUST land in handleUrl, never in
    // channelId. If the routing regresses, the worker's resolution
    // branch will silently skip again — there is no other observable
    // signal at the ingest layer.
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Handle paste (cache miss)",
        authorName: "Handle Dev",
        authorUrl: "https://www.youtube.com/@handle-regress-3b",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-handle-miss@test.local" });

    // No cache row + no handle_aliases entry → cache miss → enqueue path.
    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10hnd001ab",
      "127.0.0.1",
    );

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(1);
    const job = enqueues[0]!;

    // Load-bearing assertion: handleUrl is the carrier; channelId is absent.
    expect(job.data).toMatchObject({
      handleUrl: "https://www.youtube.com/@handle-regress-3b",
      userId: u.id,
    });
    expect((job.data as Record<string, unknown>).channelId).toBeUndefined();

    // singletonKey contains the handle URL so pg-boss dedups concurrent
    // pastes of the same handle.
    const opts = job.options as { singletonKey?: string };
    expect(opts.singletonKey).toBe("https://www.youtube.com/@handle-regress-3b");
  });

  it("Test 4: non-YouTube paste (Twitter) → ZERO channel-context enqueue (no false positives on other kinds)", async () => {
    twSpy.mockResolvedValue({
      authorName: "Anna Indie",
      authorHandle: "AnnaIndie",
      html: "<blockquote>Tweet body</blockquote>",
    });
    const u = await seedUserDirectly({ email: "p10-tw@test.local" });

    await parsePasteAndCreate(u.id, null, "https://twitter.com/AnnaIndie/status/9999", "127.0.0.1");

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("twitter_post");

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(0);
  });

  it("Test 5: oEmbed returns 200 with EMPTY author_url → event row created; ZERO enqueue (silent skip — backfill is best-effort)", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "No-author video",
        authorName: "",
        authorUrl: "",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "p10-noauth@test.local" });

    await parsePasteAndCreate(
      u.id,
      null,
      "https://www.youtube.com/watch?v=p10noa001ab",
      "127.0.0.1",
    );

    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(1);

    const enqueues = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(enqueues).toHaveLength(0);
  });
});

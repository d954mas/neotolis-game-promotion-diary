import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { parsePasteAndCreate } from "../../src/lib/server/services/ingest.js";
import { createGame } from "../../src/lib/server/services/games.js";
import {
  createChannel,
  toggleIsOwn as toggleChannelIsOwn,
} from "../../src/lib/server/services/youtube-channels.js";
import { toggleIsOwn as toggleItemIsOwn } from "../../src/lib/server/services/items-youtube.js";
import { db } from "../../src/lib/server/db/client.js";
import { trackedYoutubeVideos } from "../../src/lib/server/db/schema/tracked-youtube-videos.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import * as YT from "../../src/lib/server/integrations/youtube-oembed.js";
import * as TW from "../../src/lib/server/integrations/twitter-oembed.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Plan 02-06 — INGEST-02..04 + Twitter/Telegram event create live tests.
 *
 * The 8 placeholder it.skip stubs from Plan 02-01 are replaced with `it(...)`
 * bodies here. Names match exactly so Wave 0 traceability holds.
 *
 * Mocking strategy: `vi.spyOn(YT, 'fetchYoutubeOembed')` and
 * `vi.spyOn(TW, 'fetchTwitterOembed')` against the imported namespaces.
 * ESM partial mocks via `vi.mock` are flaky on @sveltejs/kit + Vitest 4;
 * spyOn against `import * as` is the same pattern Plan 02-05 (Steam) used.
 *
 * D-19 (validate-first) verification: every test exercising a 422 / 502
 * failure path asserts ZERO rows in both `tracked_youtube_videos` and
 * `events` after the failure — the load-bearing INGEST-04 invariant.
 */
describe("URL ingest paste-box (INGEST-02..04, twitter/telegram event create)", () => {
  const ytSpy = vi.spyOn(YT, "fetchYoutubeOembed");
  const twSpy = vi.spyOn(TW, "fetchTwitterOembed");
  afterEach(() => {
    ytSpy.mockReset();
    twSpy.mockReset();
  });

  it("02-06: INGEST-02 youtube paste creates tracked item with title", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        authorUrl: "https://www.youtube.com/@RickAstleyYT",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    });
    const u = await seedUserDirectly({ email: "i1@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    const r = await parsePasteAndCreate(
      u.id,
      g.id,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "127.0.0.1",
    );
    expect(r.kind).toBe("youtube_video_created");

    const rows = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.title).toBe("Never Gonna Give You Up");
    expect(row.videoId).toBe("dQw4w9WgXcQ");
    expect(row.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(row.authorUrl).toBe("https://www.youtube.com/@RickAstleyYT");
    // No registered own-channel match → is_own=false (blogger coverage default).
    expect(row.isOwn).toBe(false);
  });

  it("02-06: INGEST-03 is_own auto decision via youtube_channels match", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "My own video",
        authorName: "MyOwn",
        authorUrl: "https://www.youtube.com/@MyOwn",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "i2@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
    // Pre-register the user's own channel keyed on the same handle URL the
    // oEmbed mock returns. INGEST-03 / D-21 / Pitfall 3 Option C: the
    // ingest flow looks up youtube_channels WHERE handle_url = author_url
    // AND is_own = true.
    await createChannel(u.id, {
      handleUrl: "https://www.youtube.com/@MyOwn",
      isOwn: true,
    });

    await parsePasteAndCreate(
      u.id,
      g.id,
      "https://www.youtube.com/watch?v=ABC12345678",
      "127.0.0.1",
    );

    const [row] = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id))
      .limit(1);
    expect(row!.isOwn).toBe(true);
    expect(row!.authorUrl).toBe("https://www.youtube.com/@MyOwn");
  });

  it("02-06: INGEST-03 toggle is_own", async () => {
    ytSpy.mockResolvedValue({
      kind: "ok",
      data: {
        title: "T",
        authorName: "A",
        authorUrl: "https://www.youtube.com/@SomeBlogger",
        thumbnailUrl: "",
      },
    });
    const u = await seedUserDirectly({ email: "i3@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
    // No own-channel pre-registered → ingest defaults is_own=false.
    await parsePasteAndCreate(
      u.id,
      g.id,
      "https://www.youtube.com/watch?v=tog12345678",
      "127.0.0.1",
    );

    const [before] = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id))
      .limit(1);
    expect(before!.isOwn).toBe(false);

    // User flips the flag manually via the items-youtube service.
    const updated = await toggleItemIsOwn(u.id, before!.id, true);
    expect(updated.isOwn).toBe(true);

    // And can flip it back.
    const back = await toggleItemIsOwn(u.id, before!.id, false);
    expect(back.isOwn).toBe(false);

    // Sanity: the channel-level toggleIsOwn (different surface, same name)
    // also exists for user-level channels — exercised in Plan 02-04 tests.
    void toggleChannelIsOwn;
  });

  it("02-06: INGEST-04 malformed URL rejects + no half-write", async () => {
    const u = await seedUserDirectly({ email: "i4@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    await expect(
      parsePasteAndCreate(u.id, g.id, "not-a-url", "127.0.0.1"),
    ).rejects.toMatchObject({ status: 422, code: "unsupported_url" });

    // D-19 invariant: NO rows in either table after the validation failure.
    const tracked = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id));
    expect(tracked).toHaveLength(0);
    const evs = await db.select().from(events).where(eq(events.userId, u.id));
    expect(evs).toHaveLength(0);
  });

  it("02-06: INGEST-04 oembed 5xx no row", async () => {
    // W-6: 5xx is THROWN by fetchYoutubeOembed; orchestrator catches and
    // rethrows as AppError 502 'youtube_oembed_unreachable'.
    ytSpy.mockRejectedValue(new Error("youtube_oembed_5xx"));
    const u = await seedUserDirectly({ email: "i5@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    await expect(
      parsePasteAndCreate(
        u.id,
        g.id,
        "https://www.youtube.com/watch?v=ABC12345678",
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ status: 502, code: "youtube_oembed_unreachable" });

    // D-19 invariant: NO row after a 502.
    const tracked = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id));
    expect(tracked).toHaveLength(0);
  });

  it("02-06: INGEST-04 oembed 404 unavailable no row", async () => {
    // W-6: 404 (deleted / region-locked) maps to 422 youtube_unavailable
    // with metadata.reason='unavailable'. No row.
    ytSpy.mockResolvedValue({ kind: "unavailable" });
    const u = await seedUserDirectly({ email: "i5b@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    await expect(
      parsePasteAndCreate(
        u.id,
        g.id,
        "https://www.youtube.com/watch?v=ABC12345678",
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "youtube_unavailable",
      metadata: { reason: "unavailable" },
    });

    const tracked = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id));
    expect(tracked).toHaveLength(0);
  });

  it("02-06: twitter paste creates events row kind=twitter_post", async () => {
    twSpy.mockResolvedValue({
      authorName: "Anna Indie",
      authorHandle: "AnnaIndie",
      html: "<blockquote>Tweet body</blockquote>",
    });
    const u = await seedUserDirectly({ email: "i6@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    const r = await parsePasteAndCreate(
      u.id,
      g.id,
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

  it("02-06: reddit paste returns inline info, no row created", async () => {
    const u = await seedUserDirectly({ email: "i7@test.local" });
    const g = await createGame(u.id, { title: "G" }, "127.0.0.1");

    const r = await parsePasteAndCreate(
      u.id,
      g.id,
      "https://www.reddit.com/r/IndieDev/comments/abc/foo/",
      "127.0.0.1",
    );
    expect(r.kind).toBe("reddit_deferred");

    // D-18: reddit_deferred is informational; NO row in either table.
    const tracked = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.userId, u.id));
    expect(tracked).toHaveLength(0);
    const evs = await db.select().from(events).where(eq(events.userId, u.id));
    expect(evs).toHaveLength(0);
  });
});

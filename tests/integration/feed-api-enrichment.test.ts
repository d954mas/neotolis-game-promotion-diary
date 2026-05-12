// Phase 03.0.3 P2 — feed enrichment invariants (issue #29 Part 2).
//
// Two behavioural tests (D-C2):
//   (1) GET /api/events with cursor pagination returns rows enriched with
//       stats + channelTitle (the gap pre-fix — SSR first batch enriched
//       inline; cursor-paginated batches dropped both).
//   (2) GET /api/events/deleted does NOT carry the enrichment — deliberate
//       skip (DeletedEventsPanel renders compact KindIcon + strikethrough-
//       title view; enrichment query would be wasted I/O).
//
// Uses the same dynamic-import scaffold as api-sources-refresh-content.test.ts
// so vi.mock can intercept getBoss before any service module loads (createSource
// indirectly imports the queue client via onSourceCreated).

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async () => "mock-job-id",
      schedule: async () => {},
      createQueue: async () => {},
      work: async () => {},
    }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos, youtubeVideoSnapshots } =
  await import("../../src/lib/sources/youtube/server/schema/index.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const newChannelKey = (): string => `UC${uniq()}${uniq().slice(0, 8)}aa`;

describe("feed-api-enrichment — Phase 03.0.3 P2 (issue #29 Part 2)", () => {
  it("(1) GET /api/events returns rows with stats + channelTitle (adapter loop fires on cursor pagination)", async () => {
    const u = await seedUserDirectly({ email: `enrich-1-${uniq()}@test.local` });
    const channelKey = newChannelKey();
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelKey}`,
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );

    const videoId = `vid_${uniq()}_${uniq().slice(0, 8)}`;
    const polledAt = new Date();
    await db.insert(youtubeVideos).values({
      videoId,
      title: "Test video",
      channelId: channelKey,
      channelTitle: "Test Channel",
      publishedAt: new Date(),
    });
    await db.insert(youtubeVideoSnapshots).values({
      videoId,
      polledAt,
      viewCount: 1234,
      likeCount: 56,
      commentCount: 7,
    });
    await db.insert(events).values({
      userId: u.id,
      sourceId: src.id,
      kind: "youtube_video",
      authorIsMe: true,
      occurredAt: new Date(),
      title: "Test video",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      externalId: videoId,
    });

    const app = createApp();
    const res = await app.request("/api/events", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    const myRow = body.rows.find((r) => r.externalId === videoId);
    expect(myRow, "seeded youtube_video row missing from /api/events response").toBeDefined();
    // Enrichment landed: stats object + channelTitle string.
    expect(myRow!.stats).toMatchObject({
      viewCount: 1234,
      likeCount: 56,
      commentCount: 7,
    });
    expect(myRow!.channelTitle).toBe("Test Channel");
  });

  it("(2) GET /api/events/deleted does NOT carry the enrichment (deliberate skip — DeletedEventsPanel compact view)", async () => {
    const u = await seedUserDirectly({ email: `enrich-2-${uniq()}@test.local` });
    const channelKey = newChannelKey();
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelKey}`,
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );

    const videoId = `vid_${uniq()}_${uniq().slice(0, 8)}`;
    await db.insert(youtubeVideos).values({
      videoId,
      title: "Test video",
      channelId: channelKey,
      channelTitle: "Test Channel",
      publishedAt: new Date(),
    });
    await db.insert(youtubeVideoSnapshots).values({
      videoId,
      polledAt: new Date(),
      viewCount: 1234,
      likeCount: 56,
      commentCount: 7,
    });
    await db.insert(events).values({
      userId: u.id,
      sourceId: src.id,
      kind: "youtube_video",
      authorIsMe: true,
      occurredAt: new Date(),
      title: "Test video",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      externalId: videoId,
      deletedAt: new Date(),
    });

    const app = createApp();
    const res = await app.request("/api/events/deleted", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const myRow = body.rows.find((r) => r.externalId === videoId);
    expect(myRow, "seeded deleted event missing from /api/events/deleted").toBeDefined();
    // Deliberate skip — DeletedEventsPanel renders compact view. The DTO
    // default for stats is null (set by toEventDto); channelTitle is
    // optional and undefined when not enriched.
    expect(myRow!.stats === null || myRow!.stats === undefined).toBe(true);
    expect(myRow!.channelTitle === null || myRow!.channelTitle === undefined).toBe(true);
  });
});

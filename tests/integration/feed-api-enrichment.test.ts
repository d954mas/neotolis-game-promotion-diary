// Feed enrichment invariants (issue #29 Part 2).
//
// Two behavioural tests:
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
const {
  youtubeVideos,
  youtubeVideoSnapshots,
  youtubeChannels,
  instagramPosts,
  instagramPostSnapshots,
} = await import("../../src/lib/server/db/schema/index.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { toEventDto } = await import("../../src/lib/server/dto.js");
const { instagramEnrichFeedDtos } =
  await import("../../src/lib/sources/instagram/server/feed-enrichment.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const newChannelKey = (): string => `UC${uniq()}${uniq().slice(0, 8)}aa`;

describe("feed-api-enrichment (issue #29 Part 2)", () => {
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
    // channel display name lives on youtube_channels — feed-enrichment
    // JOINs via youtube_videos.channel_id (no-denorm fix V-1).
    await db.insert(youtubeChannels).values({
      channelId: channelKey,
      uploadsPlaylistId: `UU${channelKey.slice(2)}`,
      channelTitle: "Test Channel",
    });
    await db.insert(youtubeVideos).values({
      videoId,
      title: "Test video",
      channelId: channelKey,
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
    // channel display name lives on youtube_channels — feed-enrichment
    // JOINs via youtube_videos.channel_id (no-denorm fix V-1).
    await db.insert(youtubeChannels).values({
      channelId: channelKey,
      uploadsPlaylistId: `UU${channelKey.slice(2)}`,
      channelTitle: "Test Channel",
    });
    await db.insert(youtubeVideos).values({
      videoId,
      title: "Test video",
      channelId: channelKey,
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

  it("(3) instagramEnrichFeedDtos attaches latest stats + thumbnail; a photo's views stays null (metrics-by-presence, VIZ-05)", async () => {
    // The IG adapter isn't registered in allAdapters until Plan 05, so we
    // exercise the reader directly (the cross-source /feed loop is the same
    // call). Seed a photo post (NULL view_count — Instagram exposes
    // play_count only on reels) + its latest snapshot + the event, build the
    // dto, run the enrichment, assert the decoration.
    const u = await seedUserDirectly({ email: `enrich-ig-${uniq()}@test.local` });
    // Insert the data_source directly: createSource gates instagram_account
    // with kind_not_yet_functional (422) until the adapter lands in Plan 06.
    // The enrichment reader is post-keyed public-data and never touches
    // data_sources (no-denorm — the handle is read from the source at the UI
    // layer), so any sourceId suffices here.
    const [src] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "instagram_account",
        handleUrl: `https://www.instagram.com/handle_${uniq()}/`,
        displayName: "Test IG",
        isOwnedByMe: true,
        autoImport: false,
      })
      .returning();
    expect(src, "data_source insert returned no row").toBeDefined();

    const postId = `ig_${uniq()}_${uniq().slice(0, 8)}`;
    const polledAt = new Date();
    await db.insert(instagramPosts).values({
      postId,
      accountId: `acct_${uniq()}`,
      mediaType: "image",
      caption: "a photo",
      permalink: `https://www.instagram.com/p/${postId}/`,
      thumbnailUrl: "https://scontent.cdninstagram.com/thumb.jpg",
      publishedAt: new Date(),
    });
    // A PHOTO snapshot: view_count is NULL (no play_count for images).
    await db.insert(instagramPostSnapshots).values({
      postId,
      polledAt,
      viewCount: null,
      likeCount: 4200,
      commentCount: 88,
    });
    const [eventRow] = await db
      .insert(events)
      .values({
        userId: u.id,
        sourceId: src!.id,
        kind: "instagram_post",
        authorIsMe: true,
        occurredAt: new Date(),
        title: "a photo",
        url: `https://www.instagram.com/p/${postId}/`,
        externalId: postId,
      })
      .returning();

    const dto = toEventDto(eventRow!, []);
    await instagramEnrichFeedDtos(u.id, [dto]);

    const decorated = dto as typeof dto & {
      instagramEnrichment?: {
        stats: {
          viewCount: number | null;
          likeCount: number | null;
          commentCount: number | null;
        } | null;
        thumbnailUrl: string | null;
        mediaType: string | null;
      };
    };
    expect(decorated.instagramEnrichment).toBeDefined();
    expect(decorated.instagramEnrichment!.stats).not.toBeNull();
    // Photo: likes/comments present, views NULL (not coerced to 0).
    expect(decorated.instagramEnrichment!.stats!.likeCount).toBe(4200);
    expect(decorated.instagramEnrichment!.stats!.commentCount).toBe(88);
    expect(decorated.instagramEnrichment!.stats!.viewCount).toBeNull();
    // Thumbnail + media_type read from instagram_posts (post-keyed public-data).
    expect(decorated.instagramEnrichment!.thumbnailUrl).toBe(
      "https://scontent.cdninstagram.com/thumb.jpg",
    );
    expect(decorated.instagramEnrichment!.mediaType).toBe("image");
  });
});

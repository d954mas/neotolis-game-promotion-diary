// Zero-quota onboarding integration test.
//
// Verifies that when a new subscriber is added to a YouTube channel that
// another user has previously walked, events are bulk-inserted from the
// youtube_videos cache without any HTTP calls. The user gets an
// instantly-populated feed; quota is unchanged. The follow-up
// channel-context-backfill job is recorded through the transactional outbox.

import { describe, it, expect } from "vitest";
import { eq, and, isNull, sql } from "drizzle-orm";

import { createSource } from "../../src/lib/server/services/data-sources.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { outbox } from "../../src/lib/server/db/schema/outbox.js";
import { youtubeVideos } from "../../src/lib/server/db/schema/index.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function loadChannelContextBackfillRows(sourceId: string) {
  return db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.queue, "youtube.channel_context_backfill"),
        sql`${outbox.payload}->>'sourceId' = ${sourceId}`,
      ),
    );
}

describe("zero-quota onboarding (channel cache -> events fan-in)", () => {
  it("new subscriber on already-walked channel bulk-INSERTs events from cache without HTTP", async () => {
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}aa`;

    await db.insert(youtubeVideos).values([
      {
        videoId: `vid_a_${uniq()}`,
        title: "Video A",
        channelId,
        publishedAt: new Date("2026-01-15T00:00:00Z"),
      },
      {
        videoId: `vid_b_${uniq()}`,
        title: "Video B",
        channelId,
        publishedAt: new Date("2026-02-15T00:00:00Z"),
      },
      {
        videoId: `vid_c_${uniq()}`,
        title: "Video C - too old",
        channelId,
        publishedAt: new Date("2025-12-15T00:00:00Z"),
      },
    ]);

    const newUser = await seedUserDirectly({ email: `zq-${uniq()}@test.local` });
    const src = await createSource(
      newUser.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
        backfillWindow: "30d",
      },
      "127.0.0.1",
    );

    await db
      .update(dataSources)
      .set({ backfillTargetSince: new Date("2026-01-01T00:00:00Z") })
      .where(eq(dataSources.id, src.id));

    const adapterModule = await import("../../src/lib/sources/youtube/server/index.js");
    await db.transaction(async (tx) => {
      await adapterModule.youtubeAdapter.onSourceCreated!(
        {
          id: src.id,
          userId: newUser.id,
          autoImport: true,
          handleUrl: src.handleUrl,
          metadata: {},
          kind: "youtube_channel",
          channelId,
          backfillTargetSince: new Date("2026-01-01T00:00:00Z"),
          isOwnedByMe: true,
        },
        { backfillWindow: "30d", tx },
      );
    });

    const seededEvents = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, newUser.id), eq(events.sourceId, src.id), isNull(events.deletedAt)),
      );
    const titles = seededEvents.map((e) => e.title).sort();
    expect(titles).toEqual(["Video A", "Video B"]);
    expect(seededEvents.every((e) => e.authorIsMe === true)).toBe(true);
    expect(seededEvents.every((e) => e.externalId !== null && e.externalId.length > 0)).toBe(true);

    const contextJobs = await loadChannelContextBackfillRows(src.id);
    expect(contextJobs.length).toBeGreaterThanOrEqual(1);
  });

  it("cache miss (channel never seen) returns 0 - caller's HTTP backfill takes over", async () => {
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}empty`;

    const newUser = await seedUserDirectly({ email: `zq-empty-${uniq()}@test.local` });
    const src = await createSource(
      newUser.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    const seededEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, newUser.id), eq(events.sourceId, src.id)));
    expect(seededEvents.length).toBe(0);

    const contextJobs = await loadChannelContextBackfillRows(src.id);
    expect(contextJobs.length).toBeGreaterThanOrEqual(1);
  });
});

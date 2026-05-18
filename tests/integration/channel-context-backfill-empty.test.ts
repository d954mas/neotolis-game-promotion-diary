// Channel-context-backfill on naturally-empty channel.
//
// Pre-fix the handler returned early on `collected.length === 0` and skipped
// the terminal channel-state writes at the bottom of the function. A
// brand-new channel with zero uploads (or a window-restricted walk that
// returned zero items before stopReason was recorded) stayed
// backfill_complete=false forever, and cron re-walked it every day at 3am
// Pacific — the very onboarding double-walk we set out to eliminate.
//
// This test invokes handleChannelContextBackfill against a mocked YouTube
// fetch layer that returns:
//   (1) channels.list → one channel with a valid uploadsPlaylistId
//   (2) playlistItems.list → empty items, no nextPageToken (stopReason="no_more_pages")
//
// Assertion: after the handler returns, dataSourceChannelState row has
// backfill_complete=true and last_backfill_page_token=null. Pre-fix this
// row would either be missing entirely or carry complete=false.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    hasYoutubeApiKeys: () => true,
    youtubeQuotaUser: () => "test-quota-user",
  };
});

vi.mock("../../src/lib/sources/youtube/server/http.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const channelsListBody = {
    kind: "youtube#channelListResponse",
    items: [
      {
        id: "UC_TEST_EMPTY_CHANNEL",
        snippet: { title: "Empty Test Channel" },
        contentDetails: { relatedPlaylists: { uploads: "UU_TEST_EMPTY_CHANNEL" } },
      },
    ],
  };
  const playlistItemsEmptyBody = {
    kind: "youtube#playlistItemListResponse",
    items: [],
  };
  return {
    ...actual,
    chargedFetch: async (url: URL): Promise<Response> => {
      const path = url.pathname;
      if (path.endsWith("/channels")) {
        return new Response(JSON.stringify(channelsListBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.endsWith("/playlistItems")) {
        return new Response(JSON.stringify(playlistItemsEmptyBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected url" }), { status: 500 });
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { handleChannelContextBackfill } =
  await import("../../src/lib/sources/youtube/server/handlers/channel-context-backfill.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("channel-context-backfill — naturally-empty channel", () => {
  beforeEach(async () => {
    await db
      .delete(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "youtube_channel"),
          eq(dataSourceChannelState.channelKey, "UC_TEST_EMPTY_CHANNEL"),
        ),
      );
  });

  it("empty playlistItems → backfill_complete=true (no double-walk on next cron tick)", async () => {
    const u = await seedUserDirectly({ email: `empty-${uniq()}@test.local` });
    const [src] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC_TEST_EMPTY_CHANNEL_${uniq()}`,
        channelId: "UC_TEST_EMPTY_CHANNEL",
        autoImport: true,
        isOwnedByMe: false,
      })
      .returning();

    await handleChannelContextBackfill({
      id: "mock-job-empty-channel",
      data: {
        userId: u.id,
        channelId: "UC_TEST_EMPTY_CHANNEL",
        sourceId: src!.id,
        backfillWindow: "30d",
      },
    });

    const stateRows = await db
      .select()
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "youtube_channel"),
          eq(dataSourceChannelState.channelKey, "UC_TEST_EMPTY_CHANNEL"),
        ),
      );
    expect(stateRows).toHaveLength(1);
    const state = stateRows[0]!;
    expect(state.backfillComplete).toBe(true);
    expect(
      (state.metadata as { lastBackfillPageToken?: string } | null)?.lastBackfillPageToken ?? null,
    ).toBe(null);
  });

  it("audit row fires with events_inserted=0 (operator visibility for empty-channel walks)", async () => {
    const u = await seedUserDirectly({ email: `empty-audit-${uniq()}@test.local` });
    const [src] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/UC_TEST_EMPTY_CHANNEL_${uniq()}`,
        channelId: "UC_TEST_EMPTY_CHANNEL",
        autoImport: true,
        isOwnedByMe: false,
      })
      .returning();

    await handleChannelContextBackfill({
      id: "mock-job-empty-audit",
      data: {
        userId: u.id,
        channelId: "UC_TEST_EMPTY_CHANNEL",
        sourceId: src!.id,
        backfillWindow: "30d",
      },
    });

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, u.id), eq(auditLog.action, "source.refresh_content_requested")),
      );
    expect(auditRows).toHaveLength(1);
    const meta = auditRows[0]!.metadata as Record<string, unknown>;
    expect(meta.events_inserted).toBe(0);
    expect(meta.source_id).toBe(src!.id);
  });
});

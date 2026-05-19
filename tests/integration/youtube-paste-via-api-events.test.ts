// YouTube paste coverage — replaces the deleted tests/integration/ingest.test.ts
// after the parsePasteAndCreate orchestrator was removed in commit 7039d0e.
//
// The new production path is POST /api/events with kind=youtube_video
// → services/events.ts createEvent → adapter.fetchEventStats. The deleted
// ingest.test.ts exercised the legacy orchestrator; this file pins the
// equivalent contract on the current code path:
//
//   1. YouTube paste creates events row with externalId derived from
//      the URL via parseAnyUrl → youtubeAdapter.parseUrl.
//   2. fetchEventStats fires post-INSERT, writes a youtube_video_snapshots
//      row, and writes the cross-source event.poll_refreshed audit row
//      (flow=stats_refresh) — load-bearing for the per-user requestsPerDay
//      cap counter.
//   3. fetchEventStats failure (quota gate returns null / adapter
//      throws) leaves the events row intact (silent degradation; cron
//      tick picks up stats later).
//   4. URL-shape mismatch → derivedExternalId is null → no fetchEventStats
//      call → no snapshot row + no audit row.
//
// Mocking strategy mirrors tests/integration/ingest-paste-then-poll.test.ts:
//   - vi.mock the quota gate to return a fake key so fetchEventStats does
//     not short-circuit at the auth gate.
//   - vi.mock youtubeChannelAdapterCore.pollStatsByVideoId to return a
//     known snapshot WITHOUT calling the real googleapis client.
//
// AGENTS.md "validate-first INGEST": failure paths (4) assert ZERO snapshot
// + ZERO audit rows, NOT just "test passed".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";

// Mock quota reservation — fetchEventStats short-circuits to null when no
// API key is configured (self-host parity). Returning a fake key lets
// the test reach the pollStatsByVideoId mock below.
vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    hasYoutubeApiKeys: () => true,
    reserveYoutubeQuota: async (args: { origin: "cron" | "user"; units: number }) => ({
      apiKey: "test-key-yt-paste",
      apiKeyId: "ytpaste001",
      poolKind: args.origin,
      units: args.units,
    }),
  };
});

const adapterMock = {
  pollStatsByVideoId: vi.fn(),
};

// fetchEventStats reads pollStatsByVideoId off youtubeChannelAdapterCore
// (imported from ./adapter.js in src/lib/sources/youtube/server/index.ts).
vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...(actual.youtubeChannelAdapterCore as Record<string, unknown>),
      pollStatsByVideoId: (...args: unknown[]) => adapterMock.pollStatsByVideoId(...args),
    },
  };
});

const { createEvent } = await import("../../src/lib/server/services/events.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { youtubeVideoSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { seedUserDirectly } = await import("./helpers.js");

describe("YouTube paste via createEvent (createEvent → fetchEventStats)", () => {
  beforeEach(() => {
    adapterMock.pollStatsByVideoId.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("YouTube paste creates events row with derived externalId + snapshot + audit", async () => {
    const u = await seedUserDirectly({ email: `yt-paste-ok-${uuidv7()}@test.local` });
    const externalId = "dQw4w9WgXcQ";

    adapterMock.pollStatsByVideoId.mockResolvedValue([
      {
        polledAt: new Date(),
        status: "ok" as const,
        metrics: { view_count: 1_400_000_000, like_count: 17_000_000, comment_count: 5_000_000 },
      },
    ]);

    const ev = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        title: "My note on this video",
        occurredAt: new Date(),
        url: `https://www.youtube.com/watch?v=${externalId}`,
      },
      "127.0.0.1",
    );

    expect(ev.kind).toBe("youtube_video");
    expect(ev.externalId).toBe(externalId);

    // Snapshot row written by fetchEventStats → writeSnapshot.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, externalId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.viewCount).toBe(1_400_000_000);
    expect(snaps[0]!.likeCount).toBe(17_000_000);
    expect(snaps[0]!.commentCount).toBe(5_000_000);

    // Cross-source audit row — load-bearing for the per-user
    // requestsPerDay cap (services/quota.ts SUMs by flow=stats_refresh).
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.poll_refreshed")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const meta = audit[0]!.metadata as Record<string, unknown>;
    expect(meta.platform).toBe("youtube_channel");
    expect(meta.flow).toBe("stats_refresh");
    expect(meta.requests_used).toBe(1);
  });

  it("fetchEventStats failure → event row exists, no snapshot, no audit (silent degradation)", async () => {
    const u = await seedUserDirectly({ email: `yt-paste-fail-${uuidv7()}@test.local` });
    const externalId = "failvideo01";

    adapterMock.pollStatsByVideoId.mockRejectedValue(new Error("youtube transient"));

    const ev = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        title: "Note despite failure",
        occurredAt: new Date(),
        url: `https://www.youtube.com/watch?v=${externalId}`,
      },
      "127.0.0.1",
    );

    // Event row created — fetchEventStats failure is swallowed.
    expect(ev.externalId).toBe(externalId);
    const evRows = await db.select().from(events).where(eq(events.id, ev.id));
    expect(evRows).toHaveLength(1);

    // No snapshot row.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, externalId));
    expect(snaps).toHaveLength(0);

    // No event.poll_refreshed audit row — writeAudit fires AFTER the
    // adapter returns ok-status snapshot, so a thrown / error-status
    // snapshot path skips it.
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.poll_refreshed")));
    expect(audit).toHaveLength(0);
  });

  it("URL not a YouTube video (kind mismatch) → externalId null → no stats fetch", async () => {
    const u = await seedUserDirectly({ email: `yt-paste-nomatch-${uuidv7()}@test.local` });

    // Pasting a non-video URL as kind=youtube_video. parseAnyUrl returns
    // null OR a different kind; either way derivedExternalId stays null
    // and the fetchEventStats branch is skipped.
    const ev = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        title: "Random typed note",
        occurredAt: new Date(),
        url: "https://example.com/not-youtube",
      },
      "127.0.0.1",
    );

    expect(ev.externalId).toBeNull();
    expect(adapterMock.pollStatsByVideoId).not.toHaveBeenCalled();

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.poll_refreshed")));
    expect(audit).toHaveLength(0);
  });
});

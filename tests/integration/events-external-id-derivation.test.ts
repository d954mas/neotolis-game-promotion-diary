import { describe, it, expect } from "vitest";
import { createEvent } from "../../src/lib/server/services/events.js";
import { seedUserDirectly } from "./helpers.js";

// External-id derivation on the manual-create path (issue #69).
//
// createEvent derives external_id from the pasted URL ONLY when the caller did
// not supply one. The derived id must be the canonical CACHE KEY for the kind —
// the value the snapshot / feed-enrichment tables join on:
//   - youtube_video / reddit_post: the URL-parsed id IS the cache key → derive.
//   - instagram_post: the URL carries only the SHORTCODE, which is NOT the
//     media-id cache key. Deriving it would save an event whose external_id
//     never matches a snapshot — stranded on the "pending" badge with no stats
//     forever. IG is excluded from URL-derivation; its media id arrives only as
//     an explicit externalId from the preview flow (POST /api/events/preview-url).

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("createEvent external_id derivation (issue #69)", () => {
  it("youtube_video with URL and no externalId DERIVES the videoId (cache key == URL id)", async () => {
    const u = await seedUserDirectly({ email: `extid-yt-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "yt no externalId",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe("dQw4w9WgXcQ");
  });

  it("instagram_post with a permalink and no externalId LEAVES external_id null (shortcode != media-id key)", async () => {
    const u = await seedUserDirectly({ email: `extid-ig-noid-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        kind: "instagram_post",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "ig permalink, no fetch",
        url: "https://www.instagram.com/p/DZKyjVKDTrE/",
      },
      "127.0.0.1",
    );
    // The shortcode DZKyjVKDTrE must NOT be stored — it would never match a
    // snapshot keyed by the media id, stranding the event on the pending badge.
    expect(ev.externalId).toBeNull();
  });

  it("instagram_post with an explicit externalId (media id from preview) STORES it verbatim", async () => {
    const u = await seedUserDirectly({ email: `extid-ig-id-${uniq()}@test.local` });
    const mediaId = "3456789012345678901";
    const ev = await createEvent(
      u.id,
      {
        kind: "instagram_post",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "ig fetched",
        url: "https://www.instagram.com/p/DZKyjVKDTrE/",
        externalId: mediaId,
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe(mediaId);
  });
});

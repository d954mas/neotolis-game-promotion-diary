import { describe, it, expect } from "vitest";
import { createEvent } from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { instagramPosts } from "../../src/lib/server/db/schema/index.js";
import { seedUserDirectly } from "./helpers.js";

// External-id derivation on the manual-create path (issue #69 + #70 P1).
//
// createEvent resolves external_id to the canonical CACHE KEY for the kind — the
// value the snapshot / feed-enrichment tables join on:
//   - youtube_video / reddit_post: the URL-parsed id IS the cache key → derive
//     from the URL when the caller didn't supply one (caller value wins).
//   - instagram_post: the media id is NOT URL-derivable (the permalink carries
//     only the shortcode) AND the request body's externalId is UNTRUSTED — a
//     client could pair post A's URL with post B's media id. createEvent
//     RE-DERIVES it from OUR OWN cache (instagram_posts.permalink = the canonical
//     url the preview UPSERTed), IGNORING the body value (#70 review P1). No cache
//     row → null → an honest stats-less card.

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

  it("instagram_post with a permalink NOT in our cache LEAVES external_id null", async () => {
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
    // No instagram_posts row for this permalink (no prior preview) → null. An
    // honest stats-less card, never the unusable shortcode.
    expect(ev.externalId).toBeNull();
  });

  it("instagram_post RE-DERIVES the media id from OUR cache by permalink, ignoring the body (#70 P1)", async () => {
    const u = await seedUserDirectly({ email: `extid-ig-cache-${uniq()}@test.local` });
    const mediaId = `media_${uniq()}`;
    const canonical = "https://www.instagram.com/p/DZKyjVKDTrE/";
    // The preview would have UPSERTed this: permalink = canonical, post_id = media id.
    await db
      .insert(instagramPosts)
      .values({ postId: mediaId, permalink: canonical })
      .onConflictDoNothing();
    const ev = await createEvent(
      u.id,
      {
        kind: "instagram_post",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "ig cached",
        url: canonical,
        // A LYING body value — must be IGNORED in favor of the cache-derived id.
        externalId: "999_attacker_supplied_wrong_id",
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe(mediaId);
  });

  it("instagram_post binds to the URL's cache row, NOT the body's (cross-post mismatch neutralized) (#70 P1)", async () => {
    const u = await seedUserDirectly({ email: `extid-ig-mismatch-${uniq()}@test.local` });
    const idA = `mediaA_${uniq()}`;
    const idB = `mediaB_${uniq()}`;
    const urlA = `https://www.instagram.com/p/PA${uniq()}/`;
    await db
      .insert(instagramPosts)
      .values([
        { postId: idA, permalink: urlA },
        { postId: idB, permalink: `https://www.instagram.com/p/PB${uniq()}/` },
      ])
      .onConflictDoNothing();
    const ev = await createEvent(
      u.id,
      {
        kind: "instagram_post",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "mismatch",
        url: urlA, // the URL points at post A
        externalId: idB, // the body LIES, claiming post B's media id
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe(idA); // bound to the URL's post…
    expect(ev.externalId).not.toBe(idB); // …never the body's
  });

  it("instagram_post canonicalizes /reels/ → /reel/ so a paste variant still matches the cache (#70)", async () => {
    const u = await seedUserDirectly({ email: `extid-ig-reels-${uniq()}@test.local` });
    const mediaId = `reelmedia_${uniq()}`;
    const code = `RL${uniq()}`;
    // Cache stored under the canonical /reel/ form (what the preview writes).
    await db
      .insert(instagramPosts)
      .values({ postId: mediaId, permalink: `https://www.instagram.com/reel/${code}/` })
      .onConflictDoNothing();
    // User pastes the plural /reels/ variant — instagramParseUrl canonicalizes it.
    const ev = await createEvent(
      u.id,
      {
        kind: "instagram_post",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        title: "ig reel variant",
        url: `https://www.instagram.com/reels/${code}/`,
        externalId: "ignored",
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe(mediaId);
  });
});

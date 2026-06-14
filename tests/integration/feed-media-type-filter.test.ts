import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { listFeedPage, listFeedFacets } from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import {
  instagramPosts,
  tiktokPosts,
  twitterPosts,
  youtubeVideos,
} from "../../src/lib/server/db/schema/index.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

// Integration guard for the cross-source MEDIA-TYPE feed filter (Short / Video
// / Other) — the SERVER SQL half (events-query.ts buildMediaTypeClause), which
// filters in SQL so cursor pagination stays honest.
//
// The load-bearing invariants:
//   1. Each single-category selection returns EXACTLY the right set across every
//      source kind (TikTok short, IG video / short / carousel, YouTube
//      short/video/NULL, Telegram post, manual conference, AND a social event
//      with NO cache row).
//   2. PARTITION: the three categories partition the feed — selecting all three
//      == no filter == the same count. No event vanishes from all three.
//   3. youtube_video's per-post default differs: media_type 'short' → short;
//      'video' OR NULL OR no cache row → video (never "other").
//
// Events are inserted directly (bypassing createEvent's adapter
// resolveCachedExternalId hook) with explicit external_id; the IG / TikTok /
// YouTube cache rows are inserted directly so the per-post EXISTS arms have rows
// to match. Public-data cache tables (instagram_posts / tiktok_posts /
// youtube_videos) have no userId column.

interface SeedOpts {
  kind:
    | "tiktok_post"
    | "instagram_post"
    | "twitter_post"
    | "youtube_video"
    | "telegram_post"
    | "conference";
  externalId?: string | null;
  /** When set + kind is a per-post kind (IG/TikTok/YouTube), a cache row is
   *  inserted with this media_type. Omit to simulate a MISSING cache row.
   *  For youtube_video, pass null explicitly to insert a row with NULL
   *  media_type (the lazily-unclassified case → video). */
  cacheMediaType?: string | null;
  occurredAt: Date;
  title: string;
}

async function seedEvent(userId: string, opts: SeedOpts): Promise<string> {
  const id = uuidv7();
  const externalId = opts.externalId ?? null;
  await db.insert(events).values({
    id,
    userId,
    kind: opts.kind,
    occurredAt: opts.occurredAt,
    title: opts.title,
    externalId,
  });
  if (opts.cacheMediaType !== undefined && externalId !== null) {
    if (opts.kind === "instagram_post") {
      await db.insert(instagramPosts).values({
        postId: externalId,
        mediaType: opts.cacheMediaType,
      });
    } else if (opts.kind === "tiktok_post") {
      await db.insert(tiktokPosts).values({
        awemeId: externalId,
        mediaType: opts.cacheMediaType,
      });
    } else if (opts.kind === "twitter_post") {
      // twitter_posts.media_type vocabulary is 'video' | 'image' | 'text'.
      await db.insert(twitterPosts).values({
        tweetId: externalId,
        mediaType: opts.cacheMediaType,
      });
    } else if (opts.kind === "youtube_video") {
      // youtube_videos requires a non-null title; media_type is the column under
      // test (NULL = not-yet-classified → video).
      await db.insert(youtubeVideos).values({
        videoId: externalId,
        title: opts.title,
        mediaType: opts.cacheMediaType,
      });
    }
  }
  return id;
}

/**
 * Seed a representative spread across every category + a missing-cache-row
 * social event, returning the per-category expected id sets.
 */
async function seedSpread(userId: string): Promise<{
  short: Set<string>;
  video: Set<string>;
  other: Set<string>;
  all: Set<string>;
}> {
  // Unique per-seed suffix so the PUBLIC-DATA cache rows (instagram_posts /
  // tiktok_posts, keyed by external_id with NO userId column) never collide
  // across users. uuidv7 user ids share a timestamp prefix, so a userId slice
  // is NOT collision-safe here.
  const uniq = Math.random().toString(36).slice(2, 12);
  // SHORT: TikTok video (now → short) + IG reel (short) + YouTube Short
  // (youtube_videos.media_type='short' — the probe verdict).
  const tkShort = await seedEvent(userId, {
    kind: "tiktok_post",
    externalId: `tk_short_${uniq}`,
    cacheMediaType: "short",
    occurredAt: new Date("2026-06-01T10:00:00Z"),
    title: "tk short",
  });
  const igShort = await seedEvent(userId, {
    kind: "instagram_post",
    externalId: `ig_short_${uniq}`,
    cacheMediaType: "short",
    occurredAt: new Date("2026-06-02T10:00:00Z"),
    title: "ig short",
  });
  const ytShort = await seedEvent(userId, {
    kind: "youtube_video",
    externalId: `yt_short_${uniq}`,
    cacheMediaType: "short",
    occurredAt: new Date("2026-06-02T12:00:00Z"),
    title: "yt short",
  });
  // VIDEO: YouTube video (media_type='video') + YouTube NULL-cache row
  // (unclassified → video) + YouTube NO-cache-row (paste-only → video) + IG
  // plain feed video.
  const ytVideo = await seedEvent(userId, {
    kind: "youtube_video",
    externalId: `yt_video_${uniq}`,
    cacheMediaType: "video",
    occurredAt: new Date("2026-06-03T10:00:00Z"),
    title: "yt video",
  });
  const ytNull = await seedEvent(userId, {
    kind: "youtube_video",
    externalId: `yt_null_${uniq}`,
    cacheMediaType: null, // cache row exists, media_type NULL → video
    occurredAt: new Date("2026-06-03T11:00:00Z"),
    title: "yt null-mediatype",
  });
  const ytNoRow = await seedEvent(userId, {
    kind: "youtube_video",
    externalId: `yt_norow_${uniq}`,
    // cacheMediaType omitted → NO youtube_videos row at all → still video.
    occurredAt: new Date("2026-06-03T13:00:00Z"),
    title: "yt no cache row",
  });
  const igVideo = await seedEvent(userId, {
    kind: "instagram_post",
    externalId: `ig_video_${uniq}`,
    cacheMediaType: "video",
    occurredAt: new Date("2026-06-04T10:00:00Z"),
    title: "ig video",
  });
  // Twitter native-video tweet (twitter_posts.media_type='video') → video.
  const twVideo = await seedEvent(userId, {
    kind: "twitter_post",
    externalId: `tw_video_${uniq}`,
    cacheMediaType: "video",
    occurredAt: new Date("2026-06-04T11:00:00Z"),
    title: "tw video",
  });
  // OTHER: IG carousel + Telegram post (kind-level) + manual conference
  // (kind-level) + a social event with NO cache row (the partition guard).
  const igCarousel = await seedEvent(userId, {
    kind: "instagram_post",
    externalId: `ig_carousel_${uniq}`,
    cacheMediaType: "carousel",
    occurredAt: new Date("2026-06-05T10:00:00Z"),
    title: "ig carousel",
  });
  const tg = await seedEvent(userId, {
    kind: "telegram_post",
    externalId: `tg_${uniq}`,
    occurredAt: new Date("2026-06-06T10:00:00Z"),
    title: "tg post",
  });
  const conf = await seedEvent(userId, {
    kind: "conference",
    occurredAt: new Date("2026-06-07T10:00:00Z"),
    title: "conference",
  });
  // A TikTok event with NO cache row (missing) — MUST land in "other", never
  // vanish from all three.
  const tkMissing = await seedEvent(userId, {
    kind: "tiktok_post",
    externalId: `tk_missing_${uniq}`,
    // cacheMediaType omitted → no cache row inserted.
    occurredAt: new Date("2026-06-08T10:00:00Z"),
    title: "tk missing cache",
  });
  // Twitter image tweet (media_type='image') → other; text tweet
  // (media_type='text') → other; missing cache row → other (the partition
  // guard — a twitter event must never vanish from all three).
  const twImage = await seedEvent(userId, {
    kind: "twitter_post",
    externalId: `tw_image_${uniq}`,
    cacheMediaType: "image",
    occurredAt: new Date("2026-06-08T11:00:00Z"),
    title: "tw image",
  });
  const twText = await seedEvent(userId, {
    kind: "twitter_post",
    externalId: `tw_text_${uniq}`,
    cacheMediaType: "text",
    occurredAt: new Date("2026-06-08T12:00:00Z"),
    title: "tw text",
  });
  const twMissing = await seedEvent(userId, {
    kind: "twitter_post",
    externalId: `tw_missing_${uniq}`,
    // cacheMediaType omitted → no cache row inserted → other.
    occurredAt: new Date("2026-06-08T13:00:00Z"),
    title: "tw missing cache",
  });

  const short = new Set([tkShort, igShort, ytShort]);
  const video = new Set([ytVideo, ytNull, ytNoRow, igVideo, twVideo]);
  const other = new Set([igCarousel, tg, conf, tkMissing, twImage, twText, twMissing]);
  const all = new Set([...short, ...video, ...other]);
  return { short, video, other, all };
}

describe("MEDIA-TYPE feed filter (Short / Video / Other) — server SQL", () => {
  it("each single-category selection returns EXACTLY the right set across every source", async () => {
    const u = await seedUserDirectly({ email: `mtf-single-${Math.random()}@t.io` });
    const exp = await seedSpread(u.id);

    const shortPage = await listFeedPage(u.id, { mediaType: ["short"] }, null);
    expect(new Set(shortPage.rows.map((r) => r.id))).toEqual(exp.short);

    const videoPage = await listFeedPage(u.id, { mediaType: ["video"] }, null);
    expect(new Set(videoPage.rows.map((r) => r.id))).toEqual(exp.video);

    const otherPage = await listFeedPage(u.id, { mediaType: ["other"] }, null);
    expect(new Set(otherPage.rows.map((r) => r.id))).toEqual(exp.other);
  });

  it("PARTITION: selecting all three categories == no filter (same rows, same count)", async () => {
    const u = await seedUserDirectly({ email: `mtf-partition-${Math.random()}@t.io` });
    const exp = await seedSpread(u.id);

    const unfiltered = await listFeedPage(u.id, {}, null);
    const allThree = await listFeedPage(u.id, { mediaType: ["short", "video", "other"] }, null);

    const unfilteredIds = new Set(unfiltered.rows.map((r) => r.id));
    const allThreeIds = new Set(allThree.rows.map((r) => r.id));

    // The categories partition the feed: union == unfiltered, same count.
    expect(allThreeIds).toEqual(unfilteredIds);
    expect(allThree.rows.length).toBe(unfiltered.rows.length);
    // And the seeded set is fully covered (no event vanished).
    expect(unfilteredIds).toEqual(exp.all);

    // No double-counting: short + video + other counts sum to the total.
    const [s, v, o] = await Promise.all([
      listFeedPage(u.id, { mediaType: ["short"] }, null),
      listFeedPage(u.id, { mediaType: ["video"] }, null),
      listFeedPage(u.id, { mediaType: ["other"] }, null),
    ]);
    expect(s.rows.length + v.rows.length + o.rows.length).toBe(unfiltered.rows.length);
  });

  it("a multi-category selection (short + video) is the UNION of those categories", async () => {
    const u = await seedUserDirectly({ email: `mtf-union-${Math.random()}@t.io` });
    const exp = await seedSpread(u.id);

    const page = await listFeedPage(u.id, { mediaType: ["short", "video"] }, null);
    expect(new Set(page.rows.map((r) => r.id))).toEqual(new Set([...exp.short, ...exp.video]));
  });

  it("the missing-cache-row social event is classified as 'other', never lost", async () => {
    const u = await seedUserDirectly({ email: `mtf-missing-${Math.random()}@t.io` });
    const uniq = Math.random().toString(36).slice(2, 12);
    const tkMissing = await seedEvent(u.id, {
      kind: "tiktok_post",
      externalId: `tk_only_missing_${uniq}`,
      occurredAt: new Date("2026-06-09T10:00:00Z"),
      title: "lonely missing-cache tiktok",
    });
    // It is NOT in short or video.
    const short = await listFeedPage(u.id, { mediaType: ["short"] }, null);
    const video = await listFeedPage(u.id, { mediaType: ["video"] }, null);
    expect(short.rows.map((r) => r.id)).not.toContain(tkMissing);
    expect(video.rows.map((r) => r.id)).not.toContain(tkMissing);
    // It IS in other.
    const other = await listFeedPage(u.id, { mediaType: ["other"] }, null);
    expect(other.rows.map((r) => r.id)).toContain(tkMissing);
    // Sanity: the cache row really is absent.
    const cacheRows = await db
      .select()
      .from(tiktokPosts)
      .where(eq(tiktokPosts.awemeId, `tk_only_missing_${uniq}`));
    expect(cacheRows).toHaveLength(0);
  });

  it("youtube_video classifies per-post: 'short' → short; 'video' / NULL / no-row → video, never other", async () => {
    const u = await seedUserDirectly({ email: `mtf-yt-${Math.random()}@t.io` });
    const uniq = Math.random().toString(36).slice(2, 12);
    const ytShort = await seedEvent(u.id, {
      kind: "youtube_video",
      externalId: `yt_s_${uniq}`,
      cacheMediaType: "short",
      occurredAt: new Date("2026-06-10T10:00:00Z"),
      title: "yt short",
    });
    const ytVideo = await seedEvent(u.id, {
      kind: "youtube_video",
      externalId: `yt_v_${uniq}`,
      cacheMediaType: "video",
      occurredAt: new Date("2026-06-10T11:00:00Z"),
      title: "yt video",
    });
    const ytNull = await seedEvent(u.id, {
      kind: "youtube_video",
      externalId: `yt_n_${uniq}`,
      cacheMediaType: null, // row present, media_type NULL → video
      occurredAt: new Date("2026-06-10T12:00:00Z"),
      title: "yt null",
    });
    const ytNoRow = await seedEvent(u.id, {
      kind: "youtube_video",
      externalId: `yt_x_${uniq}`,
      // no cache row at all → still video
      occurredAt: new Date("2026-06-10T13:00:00Z"),
      title: "yt no row",
    });

    const short = await listFeedPage(u.id, { mediaType: ["short"] }, null);
    const video = await listFeedPage(u.id, { mediaType: ["video"] }, null);
    const other = await listFeedPage(u.id, { mediaType: ["other"] }, null);
    const shortIds = new Set(short.rows.map((r) => r.id));
    const videoIds = new Set(video.rows.map((r) => r.id));
    const otherIds = new Set(other.rows.map((r) => r.id));

    // The Short lands ONLY in short.
    expect(shortIds.has(ytShort)).toBe(true);
    expect(videoIds.has(ytShort)).toBe(false);
    // 'video', NULL-media_type, and no-cache-row ALL land in video, never other.
    for (const id of [ytVideo, ytNull, ytNoRow]) {
      expect(videoIds.has(id), `${id} → video`).toBe(true);
      expect(shortIds.has(id), `${id} not short`).toBe(false);
      expect(otherIds.has(id), `${id} never other`).toBe(false);
    }
  });

  it("twitter_post classifies per-post: 'video' → video; 'image' / 'text' / no-row → other", async () => {
    const u = await seedUserDirectly({ email: `mtf-tw-${Math.random()}@t.io` });
    const uniq = Math.random().toString(36).slice(2, 12);
    const twVideo = await seedEvent(u.id, {
      kind: "twitter_post",
      externalId: `tw_v_${uniq}`,
      cacheMediaType: "video",
      occurredAt: new Date("2026-06-11T10:00:00Z"),
      title: "tw video",
    });
    const twImage = await seedEvent(u.id, {
      kind: "twitter_post",
      externalId: `tw_i_${uniq}`,
      cacheMediaType: "image",
      occurredAt: new Date("2026-06-11T11:00:00Z"),
      title: "tw image",
    });
    const twText = await seedEvent(u.id, {
      kind: "twitter_post",
      externalId: `tw_t_${uniq}`,
      cacheMediaType: "text",
      occurredAt: new Date("2026-06-11T12:00:00Z"),
      title: "tw text",
    });
    const twNoRow = await seedEvent(u.id, {
      kind: "twitter_post",
      externalId: `tw_x_${uniq}`,
      // no cache row at all → other (NOT video — twitter exact-matches 'video').
      occurredAt: new Date("2026-06-11T13:00:00Z"),
      title: "tw no row",
    });

    const short = await listFeedPage(u.id, { mediaType: ["short"] }, null);
    const video = await listFeedPage(u.id, { mediaType: ["video"] }, null);
    const other = await listFeedPage(u.id, { mediaType: ["other"] }, null);
    const shortIds = new Set(short.rows.map((r) => r.id));
    const videoIds = new Set(video.rows.map((r) => r.id));
    const otherIds = new Set(other.rows.map((r) => r.id));

    // The native-video tweet lands ONLY in video.
    expect(videoIds.has(twVideo)).toBe(true);
    expect(otherIds.has(twVideo)).toBe(false);
    expect(shortIds.has(twVideo)).toBe(false);
    // image, text, and no-cache-row ALL land in other, never video, never short
    // (a tweet is never a short-form vertical clip — no twitter 'short' arm).
    for (const id of [twImage, twText, twNoRow]) {
      expect(otherIds.has(id), `${id} → other`).toBe(true);
      expect(videoIds.has(id), `${id} not video`).toBe(false);
      expect(shortIds.has(id), `${id} not short`).toBe(false);
    }
  });

  it("listFeedFacets returns per-category counts that partition the feed (stable across same-axis toggles)", async () => {
    const u = await seedUserDirectly({ email: `mtf-facets-${Math.random()}@t.io` });
    const exp = await seedSpread(u.id);

    // No media-type axis selected → facet counts reflect the full pool.
    const facets = await listFeedFacets(u.id, {});
    expect(facets.mediaType.short).toBe(exp.short.size);
    expect(facets.mediaType.video).toBe(exp.video.size);
    expect(facets.mediaType.other).toBe(exp.other.size);
    expect(facets.mediaType.all).toBe(exp.all.size);
    // Partition: per-category counts sum to the "all" sentinel.
    expect(facets.mediaType.short + facets.mediaType.video + facets.mediaType.other).toBe(
      facets.mediaType.all,
    );

    // Stability: toggling ONE category on the TYPE axis must NOT change the
    // other categories' facet counts (the facet excludes its own axis).
    const facetsWithShort = await listFeedFacets(u.id, { mediaType: ["short"] });
    expect(facetsWithShort.mediaType.short).toBe(exp.short.size);
    expect(facetsWithShort.mediaType.video).toBe(exp.video.size);
    expect(facetsWithShort.mediaType.other).toBe(exp.other.size);
    expect(facetsWithShort.mediaType.all).toBe(exp.all.size);
  });

  it("is tenant-scoped: another user's events never leak into the media-type filter", async () => {
    const a = await seedUserDirectly({ email: `mtf-tenant-a-${Math.random()}@t.io` });
    const b = await seedUserDirectly({ email: `mtf-tenant-b-${Math.random()}@t.io` });
    const expA = await seedSpread(a.id);
    await seedSpread(b.id);

    const aShort = await listFeedPage(a.id, { mediaType: ["short"] }, null);
    // Exactly user A's short events — none of B's (which share the same cache
    // tables but different events.user_id).
    expect(new Set(aShort.rows.map((r) => r.id))).toEqual(expA.short);
  });
});

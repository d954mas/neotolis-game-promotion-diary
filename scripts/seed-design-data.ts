// One-shot seed for /design-review screenshots.
// NOT for production. NOT a fixture for tests. Just a hand-curated dataset
// so the operator can show the designer every screen with realistic content.
//
// Run: pnpm tsx scripts/seed-design-data.ts
// Idempotent: deletes the admin@test.local user (cascade) before re-seeding.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";

import { db, pool } from "../src/lib/server/db/client.js";
import { user, session } from "../src/lib/server/db/schema/auth.js";
import { games } from "../src/lib/server/db/schema/games.js";
import { dataSources } from "../src/lib/server/db/schema/data-sources.js";
import { events } from "../src/lib/server/db/schema/events.js";
import { eventGames } from "../src/lib/server/db/schema/event-games.js";
import { youtubeVideos, youtubeVideoSnapshots } from "../src/lib/server/db/schema/index.js";
import { auditLog } from "../src/lib/server/db/schema/audit-log.js";
import { gameSteamListings } from "../src/lib/server/db/schema/game-steam-listings.js";
import { uuidv7 } from "../src/lib/server/ids.js";
import { env } from "../src/lib/server/config/env.js";
import { eq } from "drizzle-orm";

const EMAIL = "admin@test.local";
const NAME = "Admin Local";

function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  console.log("Wiping previous seed for", EMAIL);
  await db.delete(user).where(eq(user.email, EMAIL));

  const userId = uuidv7();
  await db.insert(user).values({
    id: userId,
    email: EMAIL,
    name: NAME,
    emailVerified: true,
  });

  const token = randomBytes(32).toString("base64url");
  const sig = await makeSignature(token, env.BETTER_AUTH_SECRET);
  await db.insert(session).values({
    id: uuidv7(),
    userId,
    token,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  console.log(`User created (id=${userId}). Cookie: neotolis.session_token=${token}.${sig}`);

  // ─── games ────────────────────────────────────────────────────────────────
  const gameNeotolis = uuidv7();
  const gameDungeon = uuidv7();
  const gameStarweaver = uuidv7();
  await db.insert(games).values([
    {
      id: gameNeotolis,
      userId,
      title: "Neotolis: Last Light",
      coverUrl:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/367520/header.jpg",
      // releaseDate / releaseTba moved to the listing rows below per
      // denormalization-audit-2.md V-2 — games row no longer carries
      // these columns (migration drizzle/0047). Loaders derive them
      // via JOIN on game_steam_listings.release_date.
      tags: [],
      description:
        "Атмосферный метроидвания-рогалик про последний город на разрушающейся планете. Ручная пиксельная графика, вязкий бой, хардкорная сложность.",
      notes: "Главный фокус кампании. Wishlist target к релизу: 50k.",
    },
    {
      id: gameDungeon,
      userId,
      title: "Dungeon Tactics",
      coverUrl:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/646570/header.jpg",
      tags: [],
      description: "Тактика на гексах в подземельях. Кооп до 4 игроков.",
      notes: "Ранний доступ. Demo Festival осенью.",
    },
    {
      id: gameStarweaver,
      userId,
      title: "Starweaver",
      coverUrl: null,
      tags: [],
      description: null,
      notes: "Идея в работе. Дата релиза не определена.",
    },
  ]);

  await db.insert(gameSteamListings).values([
    {
      id: uuidv7(),
      userId,
      gameId: gameNeotolis,
      appId: 367520,
      label: "Full",
      name: "Neotolis: Last Light",
      coverUrl:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/367520/header.jpg",
      releaseDate: "Sep 15, 2026",
      comingSoon: "true",
      steamGenres: ["Action", "Indie", "Adventure"],
      steamCategories: ["Single-player", "Steam Achievements"],
    },
    {
      id: uuidv7(),
      userId,
      gameId: gameDungeon,
      appId: 646570,
      label: "Demo",
      name: "Dungeon Tactics — Prologue",
      coverUrl:
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/646570/header.jpg",
      releaseDate: "Dec 1, 2026",
      comingSoon: "true",
      steamGenres: ["Strategy", "RPG"],
      steamCategories: ["Multi-player", "Co-op"],
    },
    // Starweaver: TBA listing — release_date NULL is Steam's "Coming
    // soon, no date" sentinel. Loader derives releaseTba=true for this
    // game because of the NULL release_date here. Replaces the old
    // games.release_tba=true direct write per denormalization-audit-2.md
    // V-2.
    {
      id: uuidv7(),
      userId,
      gameId: gameStarweaver,
      appId: 999001,
      label: "Coming Soon",
      name: "Starweaver",
      coverUrl: null,
      releaseDate: null,
      comingSoon: "true",
      steamGenres: ["Indie"],
      steamCategories: ["Single-player"],
    },
  ]);

  // ─── data_sources ────────────────────────────────────────────────────────
  const srcYtMine = uuidv7();
  const srcYtBlogger = uuidv7();
  const srcReddit = uuidv7();
  // Twitter / Telegram / Discord seed sources removed — those source
  // kinds are not in FUNCTIONAL_KINDS (services/data-sources.ts:59), no
  // adapter ships yet. Showing them on /sources would mislead the user
  // into expecting polling that can't run.
  await db.insert(dataSources).values([
    {
      id: srcYtMine,
      userId,
      kind: "youtube_channel",
      handleUrl: "https://youtube.com/@NeotolisGames",
      channelId: "UCneotolis_main",
      displayName: "Neotolis Games",
      isOwnedByMe: true,
      autoImport: true,
      metadata: { uploads_playlist_id: "UUneotolis_main" },
    },
    {
      id: srcYtBlogger,
      userId,
      kind: "youtube_channel",
      handleUrl: "https://youtube.com/@IndieGameSpotlight",
      channelId: "UCblog_indiespot",
      displayName: "Indie Game Spotlight",
      isOwnedByMe: false,
      autoImport: true,
      metadata: { uploads_playlist_id: "UUblog_indiespot" },
    },
    {
      id: srcReddit,
      userId,
      kind: "reddit_account",
      handleUrl: "https://reddit.com/user/neotolis_dev",
      displayName: "u/neotolis_dev",
      isOwnedByMe: true,
      autoImport: true,
      // reddit_account needs metadata.username — author-poll cron reads
      // this to know whose posts to fetch. Previous seed had {subreddit}
      // which is reddit_subreddit-shaped → cron skipped this row with
      // a 'missing username' warn and the source stuck in 'Queued' forever.
      metadata: { username: "neotolis_dev" },
    },
  ]);

  // ─── youtube_videos (public-data cache) + snapshots ──────────────────────
  const videos = [
    {
      id: "dQw4w9WgXcQ",
      title: "Neotolis: Last Light — Reveal Trailer",
      channelId: "UCneotolis_main",
      channelTitle: "Neotolis Games",
      published: daysAgo(45),
      viewsTimeline: [
        [44, 320],
        [40, 1850],
        [35, 4200],
        [28, 8100],
        [21, 12500],
        [14, 16000],
        [7, 18200],
        [1, 19450],
      ] as [number, number][],
    },
    {
      id: "9bZkp7q19f0",
      title: "Dungeon Tactics — Demo Gameplay",
      channelId: "UCneotolis_main",
      channelTitle: "Neotolis Games",
      published: daysAgo(20),
      viewsTimeline: [
        [19, 80],
        [15, 540],
        [10, 1200],
        [5, 1980],
        [1, 2300],
      ] as [number, number][],
    },
    {
      id: "kJQP7kiw5Fk",
      title: "TOP 10 Upcoming Indie Games — Spring 2026",
      channelId: "UCblog_indiespot",
      channelTitle: "Indie Game Spotlight",
      published: daysAgo(7),
      viewsTimeline: [
        [6, 4200],
        [4, 18000],
        [2, 31000],
        [1, 38500],
      ] as [number, number][],
    },
  ];

  for (const v of videos) {
    await db.insert(youtubeVideos).values({
      videoId: v.id,
      title: v.title,
      description: null,
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      publishedAt: v.published,
      lastPolledAt: daysAgo(1),
      lastPollStatus: "ok",
      pollFailureCount: 0,
    });
    for (const [d, views] of v.viewsTimeline) {
      await db.insert(youtubeVideoSnapshots).values({
        id: uuidv7(),
        videoId: v.id,
        polledAt: daysAgo(d),
        viewCount: views,
        likeCount: Math.floor(views * 0.06),
        commentCount: Math.floor(views * 0.008),
      });
    }
  }

  // ─── events ──────────────────────────────────────────────────────────────
  const eventsToInsert: Array<{
    id?: string;
    kind: typeof events.$inferInsert.kind;
    sourceId: string | null;
    authorIsMe: boolean;
    title: string;
    url?: string | null;
    notes?: string | null;
    occurred: Date;
    externalId?: string | null;
    games: string[];
  }> = [
    {
      kind: "youtube_video",
      sourceId: srcYtMine,
      authorIsMe: true,
      title: "Neotolis: Last Light — Reveal Trailer",
      url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      externalId: "dQw4w9WgXcQ",
      occurred: daysAgo(45),
      games: [gameNeotolis],
      notes: "Запостили в среду 18:00 МСК. Пик просмотров на третий день после Reddit-крос-поста.",
    },
    {
      kind: "youtube_video",
      sourceId: srcYtMine,
      authorIsMe: true,
      title: "Dungeon Tactics — Demo Gameplay",
      url: "https://youtube.com/watch?v=9bZkp7q19f0",
      externalId: "9bZkp7q19f0",
      occurred: daysAgo(20),
      games: [gameDungeon],
      notes: null,
    },
    {
      kind: "youtube_video",
      sourceId: srcYtBlogger,
      authorIsMe: false,
      title: "TOP 10 Upcoming Indie Games — Spring 2026",
      url: "https://youtube.com/watch?v=kJQP7kiw5Fk",
      externalId: "kJQP7kiw5Fk",
      occurred: daysAgo(7),
      games: [gameNeotolis, gameDungeon],
      notes: "Покрытие от стороннего канала. Neotolis на 4-м месте, Dungeon Tactics упомянут.",
    },
    {
      kind: "reddit_post",
      sourceId: srcReddit,
      authorIsMe: true,
      title: "[Devlog] Тонкости level design в нашем рогалике",
      url: "https://reddit.com/r/indiedev/comments/abc123",
      externalId: "abc123",
      occurred: daysAgo(12),
      games: [gameNeotolis],
      notes: "240 апвоутов, 38 комментариев, +850 wishlist за 48 часов.",
      metadata: { subreddit: "indiedev", author: "neotolis_dev" },
    },
    {
      kind: "reddit_post",
      sourceId: srcReddit,
      authorIsMe: true,
      title: "Show your screenshot Saturday — Dungeon Tactics co-op",
      url: "https://reddit.com/r/IndieGaming/comments/xyz789",
      externalId: "xyz789",
      occurred: daysAgo(3),
      games: [gameDungeon],
      notes: null,
      metadata: { subreddit: "IndieGaming", author: "neotolis_dev" },
    },
    // Twitter / Telegram / Discord event seeds removed — those event
    // kinds are not in FUNCTIONAL_KINDS, no source rows exist to attach
    // them to, and the /sources page doesn't show their group.
    {
      kind: "conference",
      sourceId: null,
      authorIsMe: true,
      title: "DevGamm Minsk 2026 — Indie Showcase",
      url: "https://devgamm.com/minsk2026",
      occurred: daysAgo(28),
      games: [gameNeotolis, gameDungeon],
      notes: "Стенд 2 дня. Зарегали ~600 wishlist, собрали 40 контактов прессы.",
    },
    {
      kind: "talk",
      sourceId: null,
      authorIsMe: true,
      title: "Talk: 'Building atmosphere on a 12-month budget'",
      occurred: daysAgo(28),
      games: [gameNeotolis],
      notes: "30 мин на маленькой сцене DevGamm, ~80 слушателей.",
    },
    {
      kind: "press",
      sourceId: null,
      authorIsMe: false,
      title: "PCGamer: '12 indie games to watch this fall'",
      url: "https://pcgamer.com/12-indie-games-fall-2026",
      occurred: daysAgo(15),
      games: [gameNeotolis],
      notes: "Mention в подборке. Спайк на странице игры в Steam +18% за день.",
    },
    {
      kind: "press",
      sourceId: null,
      authorIsMe: false,
      title: "Rock Paper Shotgun — 'Neotolis is what Hollow Knight fans deserve'",
      url: "https://rockpapershotgun.com/neotolis-preview",
      occurred: daysAgo(2),
      games: [gameNeotolis],
      notes: null,
    },
    {
      kind: "post",
      sourceId: null,
      authorIsMe: true,
      title: "Mastodon thread — постмортем nodevember",
      url: "https://mastodon.gamedev.place/@neotolis/111",
      occurred: daysAgo(60),
      games: [],
      notes: "Inbox: ещё не привязал к игре.",
    },
    {
      kind: "other",
      sourceId: null,
      authorIsMe: true,
      title: "Email-newsletter #02",
      occurred: daysAgo(35),
      games: [gameNeotolis],
      notes: "Open rate 42%, CTR на Steam 6.1%.",
    },
  ];

  for (const e of eventsToInsert) {
    const id = uuidv7();
    await db.insert(events).values({
      id,
      userId,
      sourceId: e.sourceId,
      kind: e.kind,
      authorIsMe: e.authorIsMe,
      occurredAt: e.occurred,
      title: e.title,
      url: e.url ?? null,
      notes: e.notes ?? null,
      externalId: e.externalId ?? null,
      metadata: (e as { metadata?: Record<string, unknown> }).metadata ?? {},
    });
    for (const gameId of e.games) {
      await db.insert(eventGames).values({ eventId: id, gameId, userId });
    }
  }

  // ─── audit_log ────────────────────────────────────────────────────────────
  const auditEntries: Array<{
    action: typeof auditLog.$inferInsert.action;
    days: number;
    meta: Record<string, unknown>;
  }> = [
    { action: "user.signup", days: 60, meta: {} },
    { action: "session.signin", days: 60, meta: { ip: "127.0.0.1" } },
    { action: "game.created", days: 58, meta: { game_title: "Neotolis: Last Light" } },
    { action: "game.created", days: 50, meta: { game_title: "Dungeon Tactics" } },
    {
      action: "source.added",
      days: 47,
      meta: { kind: "youtube_channel", display_name: "Neotolis Games" },
    },
    { action: "source.added", days: 45, meta: { kind: "reddit_account" } },
    { action: "event.created", days: 45, meta: { kind: "youtube_video" } },
    { action: "event.attached_to_game", days: 45, meta: { game_title: "Neotolis: Last Light" } },
    {
      action: "event.poll_refreshed",
      days: 30,
      meta: { external_id: "dQw4w9WgXcQ", view_count: 16000 },
    },
    { action: "theme.changed", days: 25, meta: { theme: "dark" } },
    {
      action: "source.toggled_auto_import",
      days: 18,
      meta: { kind: "youtube_channel", auto_import: true },
    },
    { action: "event.created", days: 12, meta: { kind: "reddit_post" } },
    { action: "event.dismissed_from_inbox", days: 8, meta: {} },
    { action: "event.edited", days: 5, meta: { kind: "press" } },
    { action: "session.signin", days: 0, meta: { ip: "127.0.0.1" } },
  ];
  for (const a of auditEntries) {
    await db.insert(auditLog).values({
      id: uuidv7(),
      userId,
      action: a.action,
      ipAddress: "127.0.0.1",
      userAgent: "Mozilla/5.0 (seed-script)",
      metadata: a.meta,
      createdAt: daysAgo(a.days),
    });
  }

  console.log("Seed complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

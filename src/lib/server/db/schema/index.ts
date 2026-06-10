// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
export * from "./adapter-refresh-queue.js";
// Order is alphabetical within the active block; FK dependency order is
// resolved by drizzle-kit at generate time via `references()`.
export * from "./api-keys-steam.js";
export * from "./data-source-channel-state.js";
export * from "./data-sources.js";
export * from "./event-games.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./games.js";
export * from "./wishlist-snapshots.js";
// Transactional outbox.
export * from "./outbox.js";
// YouTube schemas live in the per-source folder. Re-exported here so
// existing call sites (`import { youtubeVideos } from
// "$lib/server/db/schema/index.js"`) continue to compile without edit.
export * from "$lib/sources/youtube/server/schema/index.js";
// Reddit schemas — same per-source plugin layout. Drizzle's schema glob
// (`./src/lib/sources/*/server/schema/*.ts`) discovers these tables
// independently for migrate; the re-export here keeps cross-source call
// sites (`import { redditPosts } from "$lib/server/db/schema/index.js"`)
// compiling.
export * from "$lib/sources/reddit/server/schema/index.js";
// Instagram schemas — same per-source plugin layout. Drizzle's schema glob
// discovers instagram_posts / instagram_post_snapshots / social_provider_spend
// / social_provider_balance for migrate; the re-export here keeps cross-source
// call sites (`import { instagramPosts } from
// "$lib/server/db/schema/index.js"`) compiling.
export * from "$lib/sources/instagram/server/schema/index.js";
// Telegram schemas — same per-source plugin layout. Drizzle's schema glob
// discovers telegram_posts / telegram_post_snapshots / telegram_pacer for
// migrate; the re-export keeps cross-source call sites compiling.
export * from "$lib/sources/telegram/server/schema/index.js";
// TikTok schemas — same per-source plugin layout. Drizzle's schema glob
// discovers tiktok_accounts / tiktok_posts / tiktok_post_snapshots for migrate;
// the re-export keeps cross-source call sites (`import { tiktokPosts } from
// "$lib/server/db/schema/index.js"`) compiling.
export * from "$lib/sources/tiktok/server/schema/index.js";

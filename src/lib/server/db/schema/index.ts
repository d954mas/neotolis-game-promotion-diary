// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
// Phase 2.1 (Plan 02.1-01): unified data-sources + extended events table replace
// the per-platform youtube_channels / tracked_youtube_videos / game_youtube_channels
// trio. Order is alphabetical within the active block; FK dependency order is
// resolved by drizzle-kit at generate time via `references()`.
export * from "./api-keys-steam.js";
export * from "./data-source-channel-state.js";
export * from "./data-sources.js";
export * from "./event-games.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./games.js";
// Phase 03.0.1 Plan 02 — YouTube schemas relocated to per-source folder
// per D-14. Re-exported here so existing call sites
// (`import { youtubeVideos } from "$lib/server/db/schema/index.js"`)
// continue to compile without edit. The 5 youtube-*.ts files in this
// directory were moved via `git mv` to
// src/lib/sources/youtube/server/schema/.
export * from "$lib/sources/youtube/server/schema/index.js";

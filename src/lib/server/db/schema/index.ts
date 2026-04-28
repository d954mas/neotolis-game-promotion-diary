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
export * from "./data-sources.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./games.js";

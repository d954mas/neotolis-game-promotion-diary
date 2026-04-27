// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
// Phase 2 (Plan 02-03): seven new tables landed together. Order is
// alphabetical within the Phase 2 block — the FK dependency order is
// resolved by drizzle-kit at generate time via `references()`.
export * from "./api-keys-steam.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./game-youtube-channels.js";
export * from "./games.js";
export * from "./tracked-youtube-videos.js";
export * from "./youtube-channels.js";

// Reddit per-source schema barrel.
// The cross-source barrel src/lib/server/db/schema/index.ts re-exports
// from this barrel. Drizzle config glob picks up these files directly
// via `./src/lib/sources/*/server/schema/*.ts`, but the cross-source
// barrel re-export keeps `import { redditPosts } from
// "$lib/server/db/schema/index.js"` call sites compiling.
export * from "./posts.js";
export * from "./users.js";
export * from "./subreddits.js";
export * from "./post-snapshots.js";
export * from "./user-snapshots.js";
export * from "./subreddit-snapshots.js";
export * from "./subreddit-baselines.js";
export * from "./pacer.js";

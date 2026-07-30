// Reddit per-source schema barrel (Phase 12 rebuild — ScrapeCreators adapter).
// The cross-source barrel src/lib/server/db/schema/index.ts re-exports from this
// barrel so `import { redditPosts } from "$lib/server/db/schema/index.js"` call
// sites compile. drizzle.config.ts consumes the cross-source barrel (single
// entry, not a glob), so these four tables are the complete Reddit schema.
export * from "./accounts.js";
export * from "./subreddits.js";
export * from "./posts.js";
export * from "./post-snapshots.js";

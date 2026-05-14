// Reddit ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND any per-source Svelte components
// (none yet for Reddit — universal FeedCard.svelte handles reddit_post
// via its kind switch; the override escape hatch remains available if
// Reddit-specific layouts surface later).
//
// .svelte files MUST import from this barrel (not from ./server.js)
// when they want both the mapper AND any future per-source component
// re-exports. SvelteKit +page.server.ts loaders and other server
// modules must import from ./server.js to avoid bundler crashes pulling
// server-only deps into the client.
export * from "./server.js";

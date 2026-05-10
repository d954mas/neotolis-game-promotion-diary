// YouTube ui/index.ts — Phase 03.0.1 D-02.
//
// Client-safe entry: re-exports the server-safe surface AND any
// per-source Svelte components. None in 03.0.1; D-04 escape hatch
// remains available for kinds with unique layouts in Phase 03.1+
// (per-source EventCard.svelte / SourceCardRow.svelte / etc.).
//
// .svelte files MUST import from this barrel (not from ./server.js)
// when they want both the mapper AND any future per-source component
// re-exports. SvelteKit +page.server.ts loaders and other server
// modules must import from ./server.js to avoid Pitfall 7 crashes.
export * from "./server.js";

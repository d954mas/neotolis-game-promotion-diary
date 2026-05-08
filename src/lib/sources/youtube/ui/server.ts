// YouTube ui/server.ts — Phase 03.0.1 D-02 + RESEARCH.md Pitfall 7.
//
// Server-safe entry: exports ONLY pure functions (no Svelte component
// imports). Importable from SvelteKit +page.server.ts loaders without
// crashing pre-render.
//
// Per-source ui/index.ts (client-safe entry) re-exports from this file
// AND adds Svelte components. registry-ui.ts imports THIS file (server-
// safe) so /admin/quota loaders, /sources loaders, /feed loaders can all
// dispatch via getAdapterUI(kind).toCardProps without dragging .svelte
// modules into the server bundle.
export { toCardProps } from "./card-props.js";

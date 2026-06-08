// Telegram ui/server.ts — server-safe entry.
//
// Exports ONLY pure functions (no Svelte component imports). Importable
// from SvelteKit +page.server.ts loaders without crashing pre-render.
//
// Per-source ui/index.ts (client-safe entry) re-exports from this file
// AND adds Svelte components. registry-ui.ts imports THIS file (server-
// safe) so /sources loaders, /feed loaders can all dispatch via
// getAdapterUI(kind).toCardProps without dragging .svelte modules into
// the server bundle.
export { toCardProps } from "./card-props.js";

// YouTube per-source server barrel — Phase 03.0.1 D-14.
// Cross-source code (registry, worker entrypoints) imports from here.
// The internal modules (adapter, http, schema) are wired together
// inside this folder; consumers see only the adapter export.
export { youtubeChannelAdapter as youtubeAdapter } from "./adapter.js";

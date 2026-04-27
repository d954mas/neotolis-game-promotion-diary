// tsup config — bundles src/server.ts (the APP_ROLE dispatcher entrypoint)
// into build/server.js so the Dockerfile ENTRYPOINT `node build/server.js`
// has something to run.
//
// SvelteKit's adapter-node already populates build/handler.js (the SvelteKit
// request handler) and build/index.js (an unused stand-alone server we don't
// invoke). Our Hono outer server lives in src/server.ts — Vite never sees it,
// so it must be compiled separately. Order in package.json `build` matters:
// `vite build && tsup` — Vite first so build/handler.js exists, then tsup
// emits build/server.js into the same directory.
//
// `clean: false` is critical: we share build/ with SvelteKit. Wiping it would
// delete handler.js. We also avoid bundling npm deps (`noExternal: [/^\.\.?\//,
// /^\$lib/]`) so the runtime image's pruned node_modules is what gets loaded
// — keeps the bundle tiny and dependencies auditable.
//
// `define: { __SVELTEKIT_HANDLER__: ... }` substitutes the dynamic-import
// path inside src/roles/app.ts at compile time. The bundled build/server.js
// imports ./handler.js (a sibling file in build/); the source still works in
// dev (vite dev) by falling back to a relative `../../build/handler.js` lookup.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: { server: "src/server.ts" },
  outDir: "build",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  // Do NOT wipe build/ — Vite already wrote handler.js here.
  clean: false,
  sourcemap: false,
  minify: false,
  dts: false,
  // Bundle ONLY local source (anything starting with ./, ../, or $lib).
  // npm deps stay external so the runtime image's node_modules is what
  // serves them — no duplicate copies in the bundle.
  noExternal: [/^\.\.?\//, /^\$lib/],
  // Substitute the dynamic-import path. Relative to build/server.js, the
  // SvelteKit handler is at ./handler.js. In dev (no tsup pass), the
  // `typeof __SVELTEKIT_HANDLER__ !== "undefined"` guard in app.ts falls
  // back to the source-relative path.
  define: { __SVELTEKIT_HANDLER__: JSON.stringify("./handler.js") },
});

// Globals injected by tsup at build time (see tsup.config.ts `define`).
// At runtime under `node build/server.js`, `__SVELTEKIT_HANDLER__` is the
// string literal "./handler.js" (relative to build/server.js). In dev under
// `vite dev`, the constant is undefined and src/roles/app.ts falls back to
// a source-relative path — see the `typeof` guard there.

declare const __SVELTEKIT_HANDLER__: string | undefined;

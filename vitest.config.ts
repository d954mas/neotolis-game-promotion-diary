import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import path from "node:path";

// Plan 02.1-20: $lib alias mirror — Svelte components imported by tests
// (audit-render.test.ts and any future SSR-render test) use $lib/*
// internally to match svelte.config.js kit.alias. The vitest config does
// NOT pull the SvelteKit plugin (W-2 honored) so the alias must be declared
// here; otherwise component SSR rendering fails resolving $lib/paraglide/messages.js.
const $libAlias = { $lib: path.resolve("./src/lib") };

// Vitest 4 supports test.projects to split unit (no DB) from integration (with DB).
// Plan 01-02 (Phase 1 Wave 0) lands the structural split; later plans wire real assertions.
//
// - unit:        no setup file, fast, runs without Postgres.
// - integration: imports tests/setup.ts which boots a pg.Pool and runs migrations.
//
// Plan 02-09: integration tests can now import `.svelte` files (Svelte 5
// SSR via `render` from `svelte/server`) — wires the @sveltejs/vite-plugin-svelte
// plugin so Vite knows how to transform `.svelte` files at test time. We
// don't add the full sveltekit() plugin here because that would pull the
// SvelteKit runtime (handler.js, $app/* aliases) into every test process;
// the plain svelte() plugin is enough for component SSR rendering.
//
// Plan 02-11: third 'browser' project for the UX-02 360px viewport contract
// (D-42 — every Phase 2 page renders without horizontal scroll at 360px AND
// the primary CTA is reachable). Browser project uses Vitest 4's built-in
// browser mode with the Playwright provider — Chromium is the only instance
// (Firefox / WebKit deferred to Phase 6 if cross-engine layout differences
// surface). Tests assume a SvelteKit preview server is already running on
// http://localhost:5173 — CI provisions it before invoking pnpm test:browser
// (.github/workflows/ci.yml browser-tests job).
//
// Run via:
//   pnpm test:unit         (vitest --project=unit)
//   pnpm test:integration  (vitest --project=integration)
//   pnpm test:browser      (vitest --project=browser; needs vite preview running)
//   pnpm test              (all three)
export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: $libAlias },
  test: {
    projects: [
      {
        plugins: [svelte()],
        resolve: { alias: $libAlias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [svelte()],
        resolve: { alias: $libAlias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./tests/setup.ts"],
          testTimeout: 30_000,
          // Integration files share one Postgres DB and tests/setup.ts truncates every
          // table in afterEach. If two files run in parallel, file A's afterEach can
          // wipe data that file B's currently-running test depends on (observed: a
          // tenant-scope test's seeded session vanishing mid-request, surfacing as a
          // 401 from the auth middleware). Serialize file execution to keep the
          // truncate scope honest. Unit tests still run in parallel (no DB).
          pool: "forks",
          isolate: true,
          fileParallelism: false,
        },
      },
      {
        plugins: [svelte()],
        resolve: { alias: $libAlias },
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          // 30s default timeout — page.goto + viewport assertion + a CTA
          // visibility check under Chromium is well under that.
          testTimeout: 30_000,
          // Vitest 4.1+ requires the `browser.provider` to be a factory
          // import — the legacy "playwright" string was removed in favor of
          // an explicit `playwright()` call from `@vitest/browser-playwright`.
          // See https://vitest.dev/config/browser/provider.
          browser: {
            enabled: true,
            // Pass --no-sandbox + --disable-dev-shm-usage to chromium so
            // headless tests can launch inside the GitHub Actions runner
            // (Phase 2.1 round-11 CI fix). The default sandboxed launch
            // disconnects mid-test on the ubuntu-24.04 runner with
            // "Browser connection was closed while running tests" because
            // the runner's user-namespace + cgroup setup blocks chromium's
            // sandbox spawn. Both flags are standard CI-headless practice
            // and only loosen browser sandboxing inside the test process —
            // the production app surface is unaffected.
            // launchOptions is a PlaywrightProviderOptions field (passed
            // to playwright.launch); per-instance config does NOT accept
            // a `launch` key (round-10 typecheck rejected that shape).
            provider: playwright({
              launchOptions: {
                args: ["--no-sandbox", "--disable-dev-shm-usage"],
              },
            }),
            headless: true,
            instances: [{ browser: "chromium" }],
            // Custom commands that delegate to the underlying Playwright
            // page. Vitest 4's `BrowserPage` (from @vitest/browser/context)
            // is a locator surface — it doesn't expose `goto` / `evaluate`
            // natively because the default test surface is component-mode.
            // These commands run server-side (in the vitest node process,
            // where the Playwright provider holds the real Page object) and
            // let a test drive the live SvelteKit preview server end-to-end
            // (UX-02 D-42 needs real navigation against a real server).
            //
            // Access pattern: the Playwright provider attaches the per-
            // session Playwright Page object to the BrowserCommandContext.
            // The `provider.name === "playwright"` narrowing matches the
            // pattern used by Vitest's own builtin commands (see
            // @vitest/browser/dist/index.js _markTrace etc.).
            commands: {
              async goto(context, url) {
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { goto: (u: string, o?: unknown) => Promise<unknown> };
                };
                await ctx.page.goto(url, { waitUntil: "load" });
              },
              async measureScrollWidth(context) {
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { evaluate: <T>(fn: () => T) => Promise<T> };
                };
                return ctx.page.evaluate(() => document.documentElement.scrollWidth);
              },
              async measureClientWidth(context) {
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { evaluate: <T>(fn: () => T) => Promise<T> };
                };
                return ctx.page.evaluate(() => document.documentElement.clientWidth);
              },
              async currentUrl(context) {
                // Plan 02.1-07 — feed-360 placeholder needs to assert the post-
                // navigation URL after an anonymous /feed visit redirects to
                // /login. BrowserPage from @vitest/browser/context is a locator
                // surface and does not expose location/url; fetch from the
                // underlying Playwright Page directly.
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { url: () => string };
                };
                return ctx.page.url();
              },
              async measureBodyOverflowX(context) {
                // Plan 02.1-34 (UAT-NOTES.md §4.22.A regression guard): the
                // load-bearing distinction is `clip` vs `hidden` on body's
                // computed overflow-x. `hidden` paired with `overflow-y:
                // visible` coerces overflow-y to `auto` per CSS spec,
                // promoting body to a scroll container and breaking
                // position: sticky on AppHeader. `clip` crops without
                // promoting, preserving sticky.
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { evaluate: <T>(fn: () => T) => Promise<T> };
                };
                return ctx.page.evaluate(() => window.getComputedStyle(document.body).overflowX);
              },
            },
          },
        },
      },
    ],
    reporters: ["default"],
  },
});

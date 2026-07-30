import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import path from "node:path";

// $lib alias mirror — Svelte components imported by tests use $lib/*
// internally to match svelte.config.js kit.alias. The vitest config does
// NOT pull the SvelteKit plugin so the alias must be declared here;
// otherwise component SSR rendering fails resolving
// $lib/paraglide/messages.js.
const $libAlias = { $lib: path.resolve("./src/lib") };

// $app/* alias for the browser project. The browser project mounts real
// Svelte components (EventDetailContent → RefreshNowButton imports
// `$app/navigation`), but the vitest config does NOT pull the SvelteKit
// plugin (see note above), so `$app/*` is unresolvable and the component
// import fails before any test runs. The real @sveltejs/kit runtime can't
// be aliased directly either — it pulls `__sveltekit/*` virtual modules
// that only exist under the full SvelteKit build. So we alias `$app/*` to
// tiny test stubs (tests/browser/app-stubs/) that provide the small
// surface mounted components touch (invalidateAll, goto, page state) as
// inert no-ops. Component-mount tests assert DOM/structure, not navigation
// side effects, so inert stubs are sufficient and keep the suite runnable.
const appStubs = path.resolve("./tests/browser/app-stubs");
const $appAlias = {
  "$app/navigation": path.join(appStubs, "navigation.js"),
  "$app/stores": path.join(appStubs, "stores.js"),
  "$app/state": path.join(appStubs, "state.js"),
  "$app/environment": path.join(appStubs, "environment.js"),
  "$app/forms": path.join(appStubs, "forms.js"),
  "$app/paths": path.join(appStubs, "paths.js"),
};

// Vitest 4 supports test.projects to split unit (no DB) from integration (with DB).
//
// - unit:        no setup file, fast, runs without Postgres.
// - integration: imports tests/setup.ts which boots a pg.Pool and runs migrations.
//
// Integration tests can import `.svelte` files (Svelte 5 SSR via `render`
// from `svelte/server`) — wires the @sveltejs/vite-plugin-svelte plugin
// so Vite knows how to transform `.svelte` files at test time. We don't
// add the full sveltekit() plugin here because that would pull the
// SvelteKit runtime into every test process; the plain svelte() plugin
// is enough for component SSR rendering.
//
// A third 'browser' project covers the 360px viewport contract (every page
// renders without horizontal scroll at 360px AND the primary CTA is
// reachable). Browser project uses Vitest 4's built-in browser mode with
// the Playwright provider — Chromium is the only instance. Tests assume a
// SvelteKit preview server is already running on http://localhost:5173 —
// CI provisions it before invoking pnpm test:browser.
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
          env: {
            METRICS_BEARER_TOKEN: "test-metrics-token-for-ci",
            // PIN the vars whose DEFAULT is the thing under test. Vite loads the
            // developer's .env into the test process, so a machine that has these set
            // for local dev ran a different suite than CI: twitter-not-configured
            // asserts "TWITTER_PROVIDER is unset (env default)" and the pacer tests
            // assert the 5s floor, both of which a populated .env silently overrides.
            // That produced a permanent 7-test local red — and a suite that is never
            // green is a suite whose failures stop being read, which is exactly where
            // a real regression hides. Pinning here (not in .env) keeps local == CI
            // without asking anyone to gut their dev config.
            TWITTER_PROVIDER: "",
            TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS: "5000",
            // Reddit-off baseline (same reasoning as the Twitter pins): the
            // not-configured / isolation / degrade suites assert the D-08 kill-switch
            // DEFAULT, which a developer's Reddit-enabled .env silently overrides.
            // The kill-switch is an independent AND-term, so pinning it alone keeps
            // isRedditConfigured() false regardless of the shared ScrapeCreators key.
            // Reddit-ON suites re-enable via `process.env.REDDIT_IMPORT_ENABLED =
            // "true"` at file top (before env.ts loads), which wins over this pin.
            REDDIT_IMPORT_ENABLED: "false",
          },
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
        resolve: { alias: { ...$libAlias, ...$appAlias } },
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
          // Known upstream issue vitest-dev/vitest#7981 — "Browser connection
          // was closed while running tests" disconnects randomly on CI. No
          // upstream fix; ecosystem workaround is `retry` at the test
          // runner level. 2 retries is what the discussion contributors
          // converged on.
          retry: 2,
          browser: {
            enabled: true,
            // Pass --no-sandbox + --disable-dev-shm-usage to chromium so
            // headless tests can launch inside the GitHub Actions runner.
            provider: playwright({
              launchOptions: {
                channel: "chromium",
                args: ["--no-sandbox", "--disable-dev-shm-usage"],
              },
            }),
            headless: true,
            // fileParallelism on the browser config (not just CLI flag)
            // and screenshotFailures off — both per the upstream workaround
            // pattern in vitest-dev/vitest#7981.
            fileParallelism: false,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
            // Custom commands that delegate to the underlying Playwright
            // page. Vitest 4's `BrowserPage` (from @vitest/browser/context)
            // is a locator surface — it doesn't expose `goto` / `evaluate`
            // natively because the default test surface is component-mode.
            // These commands run server-side (in the vitest node process,
            // where the Playwright provider holds the real Page object) and
            // let a test drive the live SvelteKit preview server end-to-end
            // (real navigation against a real server is required).
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
                // The feed-360 viewport test needs to assert the
                // post-navigation URL after an anonymous /feed visit
                // redirects to /login. BrowserPage from
                // @vitest/browser/context is a locator surface and does
                // not expose location/url; fetch from the underlying
                // Playwright Page directly.
                const ctx = context.provider.getCommandsContext(context.sessionId) as {
                  page: { url: () => string };
                };
                return ctx.page.url();
              },
              async measureBodyOverflowX(context) {
                // The load-bearing distinction is `clip` vs `hidden` on
                // body's computed overflow-x. `hidden` paired with
                // `overflow-y: visible` coerces overflow-y to `auto` per
                // CSS spec, promoting body to a scroll container and
                // breaking position: sticky on AppHeader. `clip` crops
                // without promoting, preserving sticky.
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

// Playwright Test runner config — replaces vitest browser mode for the
// 4 active 360px responsive tests in tests/playwright/. The vitest 4
// browser provider hits an unfixed upstream issue (vitest-dev/vitest#7981
// — "Browser connection was closed while running tests" mid-RPC,
// reproduced reliably in CI rounds 1-17 of Phase 2.1 closure work).
// @playwright/test is the official Playwright team's runner; the same
// chromium binary, no birpc layer, no random disconnects.
//
// Tests assume a `pnpm preview` server is running on :5173 (CI workflow
// boots it in the same step that runs `pnpm test:browser`; locally
// `pnpm build && pnpm preview --port 5173 &`).

import { defineConfig, devices } from "@playwright/test";

// eslint-disable-next-line no-restricted-properties -- playwright.config.ts is a top-level test runner config that runs OUTSIDE the SvelteKit server (no server/config/env.ts dependency). Reading CI directly is the standard playwright config pattern; keeping the restriction would force a worse abstraction here.
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: 1,
  reporter: IS_CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-360",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 640 },
        launchOptions: {
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
    },
  ],
});

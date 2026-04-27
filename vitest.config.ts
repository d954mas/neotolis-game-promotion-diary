import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

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
// Run via:
//   pnpm test:unit         (vitest --project=unit)
//   pnpm test:integration  (vitest --project=integration)
//   pnpm test              (both)
export default defineConfig({
  plugins: [svelte()],
  test: {
    projects: [
      {
        plugins: [svelte()],
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [svelte()],
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
    ],
    reporters: ["default"],
  },
});

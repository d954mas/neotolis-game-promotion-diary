import { defineConfig } from 'vitest/config';

// Vitest 4 supports test.projects to split unit (no DB) from integration (with DB).
// Plan 01-02 (Phase 1 Wave 0) lands the structural split; later plans wire real assertions.
//
// - unit:        no setup file, fast, runs without Postgres.
// - integration: imports tests/setup.ts which boots a pg.Pool and runs migrations.
//
// Run via:
//   pnpm test:unit         (vitest --project=unit)
//   pnpm test:integration  (vitest --project=integration)
//   pnpm test              (both)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 30_000,
          // Each spec file runs in its own forked worker; avoids global pg.Pool state leak
          // between specs while keeping parallelism for unrelated files.
          pool: 'forks',
          poolOptions: { forks: { singleFork: false } },
        },
      },
    ],
    reporters: ['default'],
  },
});

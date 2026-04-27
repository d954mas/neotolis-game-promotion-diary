import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION ad-hoc (D-21 healthz/readyz separation).
// Plan 01-06 (Wave 3) lands the routes + the worker/scheduler stubs at D-01-locked paths
// (src/worker/index.ts, src/scheduler/index.ts).
describe('health and readiness', () => {
  it.skip('GET /healthz: 200 always once process is up', () => {
    /* Plan 01-06 — pure liveness, unauthenticated by design (PRIV-01 carve-out) */
  });

  it.skip('GET /readyz: 200 only after migrations applied + DB reachable', () => {
    /* Plan 01-06 — Docker healthcheck binds here */
  });

  it.skip('worker stub boots cleanly with APP_ROLE=worker', () => {
    /* Plan 01-06 — BLOCKER 4 fix: src/worker/index.ts no-op stub at D-01 path */
  });

  it.skip('scheduler stub boots cleanly with APP_ROLE=scheduler', () => {
    /* Plan 01-06 — BLOCKER 4 fix: src/scheduler/index.ts no-op stub at D-01 path */
  });
});

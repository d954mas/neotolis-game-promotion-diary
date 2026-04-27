import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION 14/15 (migrations).
// Plan 01-03 (Wave 2) lands the programmatic migrator with a Postgres advisory lock.
// VALIDATION revision 1 W2 fix locked the BIGINT-safe decimal: 5_494_251_782_888_259_377.
describe('migrations', () => {
  it.skip('idempotent on second boot (re-running migrate() is a no-op)', () => {
    /* Plan 01-03 */
  });

  it.skip('advisory lock prevents concurrent races (BIGINT 5_494_251_782_888_259_377)', () => {
    /* Plan 01-03 — spawn two app processes, assert only one runs migrate, both see final schema */
  });

  it.skip('migrations run before HTTP server binds (VALIDATION 14)', () => {
    /* Plan 01-06 (readyz wiring) verifies this end-to-end */
  });
});

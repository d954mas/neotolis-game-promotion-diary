import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION 7/8/9 (cross-tenant isolation — 404 not 403).
// Plan 01-07 (Wave 4) lands tenant-scope middleware + an audit_log sentinel; the read test
// (VALIDATION 7) lands here. The WRITE / DELETE tests (VALIDATION 8/9) are explicitly
// DEFERRED to Phase 2 because Phase 1 has no writable / deletable resource —
// 01-VALIDATION.md revision 1 W1 fix made this deferral explicit.
describe('cross-tenant isolation (404 not 403)', () => {
  it.skip('user A reading user B resource: 404 not 403', () => {
    /* Plan 01-07 — sentinel resource is an audit_log row in Phase 1 */
  });

  it.skip('user A writing user B resource: 404 — DEFERRED to Phase 2 (no writable resource)', () => {
    /* VALIDATION 8 — Phase 2 GAMES-01 lands the writable resource and turns this on */
  });

  it.skip('user A deleting user B resource: 404 — DEFERRED to Phase 2 (no deletable resource)', () => {
    /* VALIDATION 9 — Phase 2 GAMES-01 lands the deletable resource and turns this on */
  });
});

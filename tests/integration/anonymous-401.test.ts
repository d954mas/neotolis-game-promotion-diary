import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION 5/6 (anonymous-401 invariant + no-public-route invariant).
// Plan 01-07 (Wave 4) lands both — see 01-VALIDATION.md revision 1 BLOCKER 2 (vacuous-pass
// guard with MUST_BE_PROTECTED allowlist + non-empty assertion).
describe('anonymous-401 invariant', () => {
  it.skip('every protected route returns 401 without cookie', () => {
    /* Plan 01-07 — enumerate Hono app.routes; assert each → 401 (or 302 to login for SvelteKit pages).
       Vacuous-pass guard: protectedPaths.toContain('/api/me') AND protectedRoutes.length >= 1. */
  });

  it.skip('no public dashboard, share-link, or read-only viewer route exists', () => {
    /* Plan 01-07 — grep route table for `public:true`-style markers; assert empty. */
  });
});

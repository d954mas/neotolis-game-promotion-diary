import { describe, it } from 'vitest';

// Wave 0 placeholder for VALIDATION 1/2/3/4 (Better Auth Google OAuth happy path).
// Plan 01-05 (Wave 3) lands Better Auth config + oauth2-mock-server integration and turns
// these placeholders into real assertions. D-13 mechanism = oauth2-mock-server per
// CONTEXT.md <deviations> 2026-04-27.
describe('Google OAuth login', () => {
  it.skip('OAuth callback mints a HTTP-only Secure SameSite=Lax session cookie', () => {
    /* Plan 01-05 — invalidateSession reuse from Better Auth */
  });

  it.skip('GET /api/me returns 200 with user data when authenticated', () => {
    /* Plan 01-05 */
  });

  it.skip('POST /api/auth/sign-out invalidates session (cookie cleared, route 401)', () => {
    /* Plan 01-05 */
  });

  it.skip('first vs returning user: first creates account, returning user resumes data', () => {
    /* Plan 01-05 */
  });

  it.skip('sign out from all devices clears every session row for user (D-08)', () => {
    /* Plan 01-05 — "all devices" button deletes all sessions for current user_id */
  });
});

import { pool } from '../setup.js';

// Integration-test helpers. Per RESEARCH.md Pattern 8 ("Test fixtures bypass OAuth"),
// `fetchAs` injects the session cookie directly so each test doesn't pay the OAuth dance
// roundtrip cost. The cookie is minted by Plan 01-05's `seedUser` helper.
//
// Wave 0 Phase 1: these are stable signatures that Plans 03/05/07/10 can call. The bodies
// throw with descriptive messages naming the responsible plan until each piece lands.

export async function setupTestDb(): Promise<void> {
  // Plan 01-03 owns programmatic migrate; for now we just ensure the pool is reachable.
  await pool.query('select 1');
}

export interface CreatedUser {
  id: string;
  email: string;
  sessionCookie: string;
}

// Plan 01-05 lands the real implementation (Better Auth row + cookie).
export async function createUser(_email: string): Promise<CreatedUser> {
  throw new Error('createUser implementation lands in Plan 01-05');
}

// Phase 2 lands the games table; in Phase 1 the cross-tenant 404 test uses an audit_log
// row (or `/api/me` on a different user) as its sentinel resource. This stub is exported
// so Plan 10's smoke test can import the same module shape that Phase 2 will fill in.
export async function createGame(_userId: string, _title: string): Promise<{ id: string }> {
  throw new Error('games table arrives in Phase 2');
}

// fetchAs(userIdOrCookie, path, init?) — injects Better Auth session cookie.
// Plan 01-05 finalizes the cookie name (Better Auth default is `__Secure-better-auth.session_token`
// behind HTTPS, `better-auth.session_token` in dev/test).
export async function fetchAs(
  userIdOrCookie: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // Heuristic: a value containing '=' is treated as a literal cookie header; otherwise
  // it's a user id and Plan 05 will look up the cookie.
  const isLiteralCookie = userIdOrCookie.includes('=');
  if (!isLiteralCookie) {
    // Plan 05 lands the user-id → cookie lookup once seedUser persists Better Auth sessions.
    throw new Error('fetchAs(userId, ...) lookup lands in Plan 01-05');
  }

  const baseUrl = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
  const headers = new Headers(init.headers);
  headers.set('cookie', userIdOrCookie);
  return fetch(new URL(path, baseUrl), { ...init, headers });
}

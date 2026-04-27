import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/lib/server/http/app.js';

// Plan 01-07 (Wave 4) — VALIDATION 5/6 (anonymous-401 invariant + no-public-route).
// Revision 1 BLOCKER 2 fix: vacuous-pass guard with MUST_BE_PROTECTED allowlist
// + non-empty assertion. The sweep is COMPLEMENT to (not REPLACEMENT for)
// explicit per-route assertions — if no /api/* routes exist in the future, the
// sweep would silently pass. The allowlist forces it to fail loudly when
// expected routes disappear, and the explicit /api/me checks below assert the
// concrete behavior on the canonical Phase 1 route.
describe('anonymous-401 sweep (PRIV-01, VALIDATION 5/6)', () => {
  const app = createApp();

  // Whitelist of endpoints that are intentionally unauthenticated.
  // /healthz and /readyz are pure liveness — CONTEXT.md deferred section
  // explicitly excludes them from "every endpoint refuses anonymous".
  const PUBLIC_PATHS = ['/healthz', '/readyz'];

  // Auth handler routes are managed by Better Auth and have their own auth model
  // (OAuth callbacks must accept anonymous requests by definition).
  const AUTH_HANDLER_PREFIX = '/api/auth';

  // Hardcoded allowlist: these routes MUST be in the swept set (vacuous-pass guard).
  // The sweep above is a COMPLEMENT to (not a REPLACEMENT for) explicit per-route
  // assertions — if no /api/* routes exist in the future, the sweep would silently
  // pass. The allowlist forces the sweep to fail loudly when expected routes
  // disappear.
  const MUST_BE_PROTECTED = ['/api/me'];

  it('every /api/* route except /api/auth/* refuses anonymous with 401', async () => {
    // Hono exposes app.routes (array of {path, method, handler}).
    const routes = (app as unknown as { routes: Array<{ path: string; method: string }> }).routes;
    const protectedRoutes = routes.filter((r) => {
      if (!r.path.startsWith('/api/')) return false;
      if (r.path.startsWith(AUTH_HANDLER_PREFIX)) return false;
      if (PUBLIC_PATHS.some((p) => r.path === p)) return false;
      return true;
    });
    const protectedPaths = protectedRoutes.map((r) => r.path);

    // Vacuous-pass guard 1: must contain every allowlisted route.
    for (const required of MUST_BE_PROTECTED) {
      expect(protectedPaths).toContain(required);
    }
    // Vacuous-pass guard 2: must be non-empty.
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(1);

    for (const r of protectedRoutes) {
      // Substitute :param placeholders with sentinel value.
      const path = r.path.replace(/:[A-Za-z_]+/g, 'fixture-id');
      const method = r.method === 'ALL' ? 'GET' : r.method;
      const res = await app.request(path, { method });
      expect.soft(res.status, `${method} ${path} should be 401`).toBe(401);
    }
  });

  it('VALIDATION 6: no public dashboard / share-link / read-only viewer route exists', async () => {
    // Phase 1 invariant: PRIV-01 — no public routes anywhere (PITFALL P18).
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    for (const r of routes) {
      // No route may live under '/share', '/public', '/embed'.
      expect(r.path).not.toMatch(/^\/(share|public|embed)\//);
    }
  });

  it('AUTH-01: /api/me with no cookie returns 401 + {error:"unauthorized"} (Pattern 3)', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('AUTH-01: /api/me with valid session returns 200 + UserDto', async () => {
    const { seedUserDirectly } = await import('./helpers.js');
    const seeded = await seedUserDirectly({ email: 'priv@test.local', name: 'Priv Tester' });
    const res = await app.request('/api/me', {
      headers: { cookie: `neotolis.session_token=${seeded.sessionToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(seeded.id);
    expect(body.email).toBe('priv@test.local');
    expect(body.name).toBe('Priv Tester');
    // P3: DTO must NOT contain provider tokens or google_sub.
    expect(body).not.toHaveProperty('googleSub');
    expect(body).not.toHaveProperty('refreshToken');
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('idToken');
  });
});

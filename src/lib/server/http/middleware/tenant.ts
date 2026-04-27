// Tenant-scope middleware (Plan 01-07 — Wave 4).
//
// Mount on '/api/*' AFTER the '/api/auth/*' mount so Better Auth's own routes
// are NOT intercepted (Better Auth must handle anonymous OAuth callback
// requests before this guard fires).
//
// Returns:
//   - 401 with body `{ error: 'unauthorized' }` if no valid session.
//   - calls next() with `c.var.userId` and `c.var.sessionId` set if authed.
//
// PRIV-01 / Pattern 3 (two-layer enforcement):
//   - Middleware enforces "must be SOMEONE" (= 401 if anonymous).
//   - Service functions enforce "must be the OWNER" (= NotFoundError if the
//     row is not theirs, which translates to 404 — never 403 — at the HTTP
//     boundary).
//
// The middleware does NOT enforce cross-tenant 404 — it has no view into the
// resource being accessed yet. That's the service-function responsibility,
// established here by convention (every service function takes `userId` first;
// the row is filtered by it; missing or other-tenant rows throw NotFoundError).

import type { MiddlewareHandler } from 'hono';
import { auth } from '../../../auth.js';
import { logger } from '../../logger.js';

export const tenantScope: MiddlewareHandler<{
  Variables: { userId: string; sessionId: string };
}> = async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('userId', result.user.id);
  c.set('sessionId', result.session.id);
  logger.debug(
    { userId: result.user.id, route: c.req.path },
    'tenant-scope: authed',
  );
  return next();
};

// Audit-context helper.
//
// Combines the resolved client IP (set by proxyTrust middleware as
// `clientIp`) with the authenticated user (set by tenantScope as `userId`)
// and the request's User-Agent for use as the audit-log row payload.
//
// Usage:
//
//   ```ts
//   import { writeAudit } from '$lib/server/audit.js';
//   import { getAuditContext } from '$lib/server/http/middleware/audit-ip.js';
//
//   apiGames.post('/', async (c) => {
//     const game = await createGame(c.var.userId, await c.req.json());
//     await writeAudit({
//       ...getAuditContext(c),
//       action: 'game.create',
//       metadata: { gameId: game.id },
//     });
//     return c.json(game, 201);
//   });
//   ```

import type { Context } from "hono";

/** Extract resolved-IP + user info from Hono context for audit-log writes. */
export function getAuditContext(c: Context): {
  userId: string;
  ipAddress: string;
  userAgent: string | null;
} {
  return {
    userId: c.get("userId") as string,
    ipAddress: c.get("clientIp") as string,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

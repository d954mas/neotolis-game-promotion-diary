// Shared route helpers (Plan 02-08).
//
// `mapErr` translates service-layer exceptions into the wire-format error
// envelope. Every Phase 2 route file imports this so error mapping is
// uniform across the surface and a future change (e.g. adding a new
// AppError code with custom 4xx handling) lands in one place.
//
// Error envelope contract:
//   - NotFoundError    → 404 {error: 'not_found'}     (PRIV-01 cross-tenant)
//   - AppError         → status + {error: code}        (validation_failed, etc.)
//   - everything else  → 500 {error: 'internal_server_error'} + logged
//
// Body never contains the strings 'forbidden' or 'permission' for tenant-owned
// resources (P1 invariant; see CLAUDE.md / AGENTS.md "Privacy & multi-tenancy"
// rule 2). Tests assert this via tests/integration/tenant-scope.test.ts.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { NotFoundError, AppError } from "../../services/errors.js";
import { logger } from "../../logger.js";

/** Hono Variables shape every Phase 2 route handler relies on. */
export type RouteVars = {
  Variables: {
    userId: string;
    sessionId: string;
    clientIp: string;
    clientProto: "http" | "https";
  };
};

/**
 * Translate a service-layer exception to the wire-format error envelope.
 * Returns the Response from `c.json(...)`; callers should `return mapErr(...)`.
 *
 * The status type is widened to `ContentfulStatusCode` so AppError subclasses
 * carrying any 4xx/5xx status (422, 502, 409, ...) flow through without a
 * per-route mapping table.
 */
export function mapErr(c: Context, err: unknown, route: string): Response {
  if (err instanceof NotFoundError) {
    return c.json({ error: "not_found" }, 404);
  }
  if (err instanceof AppError) {
    return c.json({ error: err.code }, err.status as ContentfulStatusCode);
  }
  logger.error({ err, route }, "unhandled route error");
  return c.json({ error: "internal_server_error" }, 500);
}

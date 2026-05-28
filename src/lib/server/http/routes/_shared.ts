// Shared route helpers.
//
// `mapErr` translates service-layer exceptions into the wire-format error
// envelope. Every route file imports this so error mapping is uniform
// across the surface and a future change (e.g. adding a new AppError code
// with custom 4xx handling) lands in one place.
//
// Error envelope contract:
//   - NotFoundError    → 404 {error: 'not_found'}     (cross-tenant)
//   - AppError         → status + {error: code, metadata?: {...}}
//                        (validation_failed, steam_listing_duplicate, etc.)
//   - everything else  → 500 {error: 'internal_server_error'} + logged
//
// AppError.metadata is forwarded into the JSON body when present
// (non-empty object). UI surfaces can read structured hints (e.g.
// `existingGameId` / `existingState`) without the anti-pattern of parsing
// the human-readable message string. Empty metadata stays omitted from
// the wire so callers without metadata see the exact same {error: code}
// body they always have.
//
// Body never contains the strings 'forbidden' or 'permission' for
// tenant-owned resources (see CLAUDE.md / AGENTS.md "Privacy &
// multi-tenancy" rule 2). Tests assert this via
// tests/integration/tenant-scope.test.ts.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { NotFoundError, AppError } from "../../services/errors.js";
import { logger } from "../../logger.js";

/** Hono Variables shape every route handler relies on. */
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
    // Forward AppError.metadata when non-empty so UI surfaces can read
    // structured hints (e.g. `existingGameId` / `existingState`) without
    // the anti-pattern of parsing the human-readable message string.
    // Empty metadata stays omitted from the wire so callers without
    // metadata see the exact same {error: code} body they always have.
    const hasMetadata = err.metadata && Object.keys(err.metadata).length > 0;
    if (hasMetadata) {
      return c.json(
        { error: err.code, metadata: err.metadata },
        err.status as ContentfulStatusCode,
      );
    }
    return c.json({ error: err.code }, err.status as ContentfulStatusCode);
  }
  logger.error({ err, route }, "unhandled route error");
  return c.json({ error: "internal_server_error" }, 500);
}

/**
 * Global Hono error handler — the catch-all for any exception that escapes
 * a route's own try/catch (and `mapErr`), or is thrown from middleware.
 * Wired via `app.onError(honoErrorHandler)` in app.ts.
 *
 * Without it, an uncaught throw falls to @hono/node-server, which prints a
 * raw plain-text stack trace to stderr — bypassing Pino and invisible to
 * the Grafana error panel. Logging here emits structured JSON (level 50)
 * and returns the same `internal_server_error` envelope mapErr produces,
 * so the wire contract is uniform whether an error was caught per-route or
 * escaped to the global handler.
 */
export function honoErrorHandler(err: unknown, c: Context): Response {
  logger.error(
    { err, path: c.req.path, method: c.req.method },
    "unhandled hono error",
  );
  return c.json({ error: "internal_server_error" }, 500);
}

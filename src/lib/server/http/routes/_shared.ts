// Shared route helpers (Plan 02-08).
//
// `mapErr` translates service-layer exceptions into the wire-format error
// envelope. Every Phase 2 route file imports this so error mapping is
// uniform across the surface and a future change (e.g. adding a new
// AppError code with custom 4xx handling) lands in one place.
//
// Error envelope contract:
//   - NotFoundError    → 404 {error: 'not_found'}     (PRIV-01 cross-tenant)
//   - AppError         → status + {error: code, metadata?: {...}}
//                        (validation_failed, steam_listing_duplicate, etc.)
//   - everything else  → 500 {error: 'internal_server_error'} + logged
//
// Plan 02.1-29 — AppError.metadata is forwarded into the JSON body when
// present (non-empty object). The route layer needed this so Plan 02.1-30's
// duplicate-listing toast can read `existingGameId` / `existingState`
// without parsing the human-readable message string. Existing AppError
// callers that did not set metadata (or set {}) are unaffected — the
// `metadata` key is omitted on empty payloads to keep the wire format
// minimal and to avoid altering the body shape that callers without
// metadata already rely on.
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
    // Plan 02.1-29: forward AppError.metadata when non-empty so
    // Plan 02.1-30's UI can read `existingGameId` / `existingState` (and
    // future AppError consumers can attach structured hints) without the
    // anti-pattern of parsing the human-readable message string. Empty
    // metadata stays omitted from the wire so callers without metadata
    // see the exact same {error: code} body they always have.
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

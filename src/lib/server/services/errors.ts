// Error taxonomy for service-layer + HTTP boundary (Plan 01-07 — Wave 4).
//
// PRIV-01 cornerstone: cross-tenant access raises `NotFoundError` (status 404),
// NOT `ForbiddenError`. Per OWASP IDOR guidance and major SaaS practice
// (Stripe / GitHub), 403 leaks resource existence — an attacker enumerating
// IDs learns "this id does exist, just not for me". 404 is indistinguishable
// from "this id never existed", which is the only safe answer.
//
// `ForbiddenError` is reserved for Phase 6+ admin endpoints where the caller
// IS authorized to know the resource exists but lacks permission for the
// specific operation. **Tenant-owned resources MUST NEVER throw
// ForbiddenError on cross-tenant access** — that would defeat the entire P1
// mitigation. Code review enforces this; the response body is also asserted
// to never contain the literal strings "forbidden" / "permission" by
// tests/integration/tenant-scope.test.ts.

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Optional structured metadata. Used by ingest (Plan 02-06) to attach
   * `{reason: 'private' | 'unavailable'}` to youtube_unavailable errors so
   * the route layer (Plan 02-08) can map a single 422 code to two distinct
   * Paraglide messages without parsing the human-readable message string.
   * Add new keys here only when the boundary needs to discriminate at
   * mapping time — message-string parsing is the anti-pattern.
   */
  readonly metadata: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    status: number,
    metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.metadata = metadata ?? {};
    this.name = this.constructor.name;
  }
}

/**
 * NotFoundError — used for cross-tenant access (PRIV-01: 404, not 403).
 *
 * Per OWASP IDOR guidance, returning 403 leaks resource existence.
 * Stripe/GitHub also return 404 for cross-account access. This is THE
 * cross-tenant carrier — every service function that fetches a tenant-owned
 * row scoped by `userId` must throw this (not ForbiddenError) when the row
 * is missing OR owned by another user.
 */
export class NotFoundError extends AppError {
  // status = 404 (HTTP). Body code: 'not_found'.
  constructor(message = "not_found") {
    super(message, "not_found", 404);
  }
}

/**
 * ForbiddenError — reserved for ADMIN endpoints (Phase 6+).
 *
 * Tenant-owned resources MUST throw NotFoundError, not ForbiddenError, on
 * cross-tenant access. The response body for any tenant-scoped 4xx must NEVER
 * contain the strings "forbidden" or "permission" (P1 invariant).
 */
export class ForbiddenError extends AppError {
  // status: 403 (HTTP) — reserved for admin endpoints (Phase 6+).
  constructor(message = "forbidden") {
    super(message, "forbidden", 403);
  }
}

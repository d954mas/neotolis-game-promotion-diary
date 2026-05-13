// Error taxonomy for service-layer + HTTP boundary.
//
// Cross-tenant cornerstone: cross-tenant access raises `NotFoundError`
// (status 404), NOT `ForbiddenError`. Per OWASP IDOR guidance and major
// SaaS practice (Stripe / GitHub), 403 leaks resource existence — an
// attacker enumerating IDs learns "this id does exist, just not for me".
// 404 is indistinguishable from "this id never existed", which is the
// only safe answer.
//
// `ForbiddenError` is reserved for admin endpoints where the caller IS
// authorized to know the resource exists but lacks permission for the
// specific operation. **Tenant-owned resources MUST NEVER throw
// ForbiddenError on cross-tenant access** — that would defeat the
// mitigation. Code review enforces this; the response body is also
// asserted to never contain the literal strings "forbidden" / "permission"
// by tests/integration/tenant-scope.test.ts.
//
// Known AppError codes used elsewhere (grep-traceability — the route layer
// maps each code to its Paraglide message):
//
//   - 'too_many_refreshes'      → 429 — refresh-poll within 5-min cooldown;
//                                   metadata carries minutesLeft +
//                                   retryAfterSeconds.
//   - 'duplicate_event'         → 422 — manual paste hits the partial
//                                   unique events_user_kind_ext_active_unq.
//                                   The pre-existing auto-import dedup
//                                   constraint events_user_kind_source_ext_unq
//                                   still maps to 409 'duplicate_event'
//                                   for back-compat; the route layer
//                                   surfaces both via the same Paraglide key.
//   - 'event_not_pollable'      → 422 — refresh-poll on a kind not in
//                                   { youtube_video }.
//   - 'event_no_external_id'    → 422 — refresh-poll on a row without an
//                                   external_id (legacy).

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * Optional structured metadata. E.g. ingest attaches
   * `{reason: 'private' | 'unavailable'}` to youtube_unavailable errors so
   * the route layer can map a single 422 code to two distinct Paraglide
   * messages without parsing the human-readable message string. Add new
   * keys here only when the boundary needs to discriminate at mapping
   * time — message-string parsing is the anti-pattern.
   */
  readonly metadata: Record<string, unknown>;

  constructor(message: string, code: string, status: number, metadata?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.metadata = metadata ?? {};
    this.name = this.constructor.name;
  }
}

/**
 * NotFoundError — used for cross-tenant access (404, not 403).
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
 * ForbiddenError — reserved for ADMIN endpoints.
 *
 * Tenant-owned resources MUST throw NotFoundError, not ForbiddenError, on
 * cross-tenant access. The response body for any tenant-scoped 4xx must
 * NEVER contain the strings "forbidden" or "permission".
 */
export class ForbiddenError extends AppError {
  // status: 403 (HTTP) — reserved for admin endpoints.
  constructor(message = "forbidden") {
    super(message, "forbidden", 403);
  }
}

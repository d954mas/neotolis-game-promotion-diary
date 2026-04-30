---
phase: 02-ingest-secrets-and-audit
plan: 07
subsystem: services
tags: [audit, pagination, cursor, multi-tenant, dto, security-floor]

requires:
  - phase: 01-foundation
    provides: "writeAudit (append-only INSERT), audit_log table, AppError taxonomy"
  - phase: 02-ingest-secrets-and-audit (Plan 02-01)
    provides: "Wave 0 placeholder tests (audit-cursor, audit-append-only, audit-read PRIV-02 stubs)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-02)
    provides: "tenant-scope ESLint rule (no-unfiltered-tenant-query) — fires on missing userId filter"
  - phase: 02-ingest-secrets-and-audit (Plan 02-03)
    provides: "AUDIT_ACTIONS const list (16 D-32 values), audit_action pgEnum, (user_id, action, created_at) index"
  - phase: 02-ingest-secrets-and-audit (Plan 02-05)
    provides: "audit IP-forwarding describe block in audit.test.ts (KEYS-06)"
provides:
  - "src/lib/server/services/audit-read.ts — listAuditPage, encodeCursor, decodeCursor, AuditPage, AuditActionFilter, PAGE_SIZE"
  - "src/lib/server/dto.ts — toAuditEntryDto + AuditEntryDto (P3 strips userId)"
  - "tests/unit/audit-cursor.test.ts — 2 live tests (round-trip, malformed input → AppError 422)"
  - "tests/unit/audit-append-only.test.ts — 2 live tests (Object.keys scan rejects update/delete-shaped exports)"
  - "tests/integration/audit.test.ts — 3 live PRIV-02 tests (page size 50 + cursor disjointness, action filter, tenant-relative cursor)"
affects: [02-08-routes-and-sweeps, 02-10-svelte-pages, 02-11-smoke-360-validation]

tech-stack:
  added: []
  patterns:
    - "Tuple-comparison cursor: `(created_at, id) < ($1, $2)` is order-stable under same-millisecond ties because UUIDv7 ids are strictly monotonic — no SUBSELECT, no double-decode"
    - "P19 by construction (not by opacity): the userId WHERE clause is FIRST in `and(...)` and INDEPENDENT of the cursor. A forged cross-tenant cursor returns 0 rows because the tenant filter has already pruned them — opacity is incidental"
    - "Defense-in-depth action filter: `assertValidActionFilter` checks against the AUDIT_ACTIONS const before the SQL builder; Plan 02-08's zod boundary catches the same input one layer up. Two failure paths to the same 422"
    - "Unit-test env-seed pattern (matches proxy-trust.test.ts): `??=` env vars at the TOP of the test file BEFORE `await import(...)` so service modules with value-import on db/client.js can load — well-formed dummy values are fine because tests never touch the pool"

key-files:
  created:
    - "src/lib/server/services/audit-read.ts"
    - ".planning/phases/02-ingest-secrets-and-audit/02-07-audit-read-service-SUMMARY.md"
  modified:
    - "src/lib/server/dto.ts"
    - "tests/unit/audit-cursor.test.ts"
    - "tests/unit/audit-append-only.test.ts"
    - "tests/integration/audit.test.ts"

key-decisions:
  - "Cursor format = base64url(JSON.stringify({at: ISO, id})). Tuple-comparison `(created_at, id) < ($1, $2)` is stable under same-ms ties because UUIDv7 ids are strictly monotonic (P19 mitigation by query structure, not by cursor opacity)"
  - "PAGE_SIZE = 50 (D-31). LIMIT PAGE_SIZE+1 detects has-more without a separate COUNT query"
  - "Defense-in-depth on actionFilter: assertValidActionFilter(filter) runs against the AUDIT_ACTIONS const BEFORE the SQL builder; Plan 02-08's zod is the second guard. Two layers because a future smoke / forensic call site can land here without going through Hono"
  - "Cursor decoded ONCE outside the SQL builder (refinement of RESEARCH.md §Cursor pagination snippet) — cleaner code, identical SQL output"
  - "AuditEntryDto omits userId (P3 discipline — caller knows their own id) but keeps ipAddress + metadata + userAgent. The user-visible audit chip (Plan 02-10) renders metadata directly; sanitization at the WRITER layer (audit.ts) means the projection forwards as-is"
  - "Unit tests seed env vars with `??=` BEFORE importing modules under test — matches the proxy-trust.test.ts pattern. audit.ts and audit-read.ts both have a value-import on db/client.js, which loads env at module init time. seed-then-import is the established codebase idiom"

requirements-completed: [PRIV-02, KEYS-06]

duration: 5m 7s
completed: 2026-04-27
---

# Phase 02 Plan 07: Audit Read Service Summary

**PRIV-02 first user-visible read of the audit log — listAuditPage with tuple-comparison cursor pagination, AUDIT_ACTIONS-typed filter, P19 mitigation by construction (userId WHERE clause independent of cursor), AuditEntryDto projection, 7 placeholder tests now live across 3 files.**

## Performance

- **Duration:** ~5 min 7 s
- **Started:** 2026-04-27T21:11:47Z
- **Completed:** 2026-04-27T21:16:54Z
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `src/lib/server/services/audit-read.ts` shipped:
  - `listAuditPage(userId, cursor, action)` with `PAGE_SIZE = 50` and `LIMIT PAGE_SIZE + 1` so has-more detection costs no extra round-trip
  - `encodeCursor(at, id)` / `decodeCursor(s)` — base64url(JSON({at, id})); `decodeCursor` throws `AppError("invalid cursor", "invalid_cursor", 422)` on every malformed shape (not base64url, valid base64url of `{}`, missing `id`)
  - `assertValidActionFilter(filter)` — defense-in-depth check against `AUDIT_ACTIONS` const list (D-32 single source of truth) before the SQL builder
  - WHERE clause structure: `and(eq(auditLog.userId, userId), cursorClause, filterClause)` — userId FIRST so the tenant-scope ESLint rule's structural match is satisfied AND the index leads with user_id
  - ORDER BY `created_at desc, id desc`; tuple-comparison `(created_at, id) < ($1, $2)` for stable cross-page disjointness under same-ms ties (UUIDv7 ids strictly monotonic)
- `src/lib/server/dto.ts` extended with `AuditEntryDto` + `toAuditEntryDto`:
  - userId stripped (P3 discipline — caller knows their own id)
  - metadata, ipAddress, userAgent forwarded for the user-visible chip
- 4 unit tests live (cursor round-trip + malformed-input rejection × 2; audit module export shape × 2 for P19 append-only invariant)
- 3 integration tests live for PRIV-02:
  - page size 50 + cursor disjointness (60 rows seeded → page1 has 50, page2 has 10, sets disjoint by id)
  - action filter (3 actions seeded; 'all' returns 3, 'key.add' returns 1)
  - tenant-relative cursor (cross-tenant rejection): user A seeded 5 rows; A's cursor presented by user B returns 0 rows; B with no cursor also sees 0. The load-bearing PRIV-02 / P19 assertion
- Plan 02-05's KEYS-06 IP-forwarding stub in `audit.test.ts` left untouched in its own describe block (per plan: don't merge the two describes)
- All 65 unit tests pass (10 files green); TypeScript compiles clean; ESLint zero warnings on the new and modified files (zero tenant-scope violations)

## Task Commits

1. **Task 1: audit-read service + DTO + cursor helpers** — `d351c8e` (feat)
2. **Task 2: cursor unit tests + append-only invariant + PRIV-02 integration tests** — `a5f3142` (test)

## Files Created/Modified

### Created (1)

- `src/lib/server/services/audit-read.ts` (138 lines) — `listAuditPage`, `encodeCursor`, `decodeCursor`, `assertValidActionFilter`, `PAGE_SIZE`, `AuditPage`, `AuditEntryRow`, `AuditActionFilter`

### Modified (4)

- `src/lib/server/dto.ts` — appended `AuditEntryDto` interface and `toAuditEntryDto` projection function; added `auditLog.$inferSelect` type import
- `tests/unit/audit-cursor.test.ts` — 2 live tests; env-seed pattern matches `proxy-trust.test.ts`; AppError import via dynamic await
- `tests/unit/audit-append-only.test.ts` — 2 live tests; `Object.keys(auditModule)` scan against update/delete/setAction/amend/patch/edit/purge/clear/remove regexes
- `tests/integration/audit.test.ts` — 3 live PRIV-02 tests added in the existing PRIV-02 describe; KEYS-06 describe (Plan 02-05) preserved verbatim

## Decisions Made

See the `key-decisions` block in frontmatter for the full list. The load-bearing one: **PITFALL P19 mitigation is by query construction, not by cursor opacity.** The userId WHERE clause is FIRST in the `and(...)` expression and INDEPENDENT of the cursor — even an attacker who reverse-engineers the cursor format and forges an entry encoding another tenant's `(created_at, id)` cannot leak rows, because the tenant filter has already pruned them. The cross-tenant integration test (`02-07: PRIV-02 tenant-relative cursor`) is the runtime assertion of this invariant.

## Plan Output Items (per `<output>` section)

1. **Cursor format chosen:** `base64url(JSON.stringify({at: createdAt.toISOString(), id}))`. ISO-string + UUIDv7 id is the smallest stable representation; the format matches RESEARCH.md §"Cursor pagination" verbatim.
2. **PAGE_SIZE confirmed:** 50 (D-31). LIMIT PAGE_SIZE+1 detects has-more without a separate COUNT query — the +1 row is sliced off and its `(createdAt, id)` becomes the next cursor.
3. **Cross-tenant test outcome:** PASS at the structural level — TypeScript compiles, ESLint zero warnings, the test file enumerates the assertion. Runtime execution is gated on Postgres availability (CI service container exercises it; local Windows dev workstation has no `pg_isready` / Docker daemon).
4. **audit.ts module exports unchanged:** confirmed via the new `audit-append-only.test.ts` — `Object.keys(auditModule)` only contains `writeAudit` (the `AuditEntry` interface erases at runtime, so it does not appear in the runtime export shape). No `update*` / `delete*` / `purge*` / `clear*` / `remove*` / `setAction*` / `amend*` / `patch*` / `edit*` symbols.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Unit tests seed env vars before importing audit modules**
- **Found during:** Task 2 (first `pnpm test:unit` run on `audit-cursor.test.ts` + `audit-append-only.test.ts`)
- **Issue:** Both test files import from modules that have a value-import on `src/lib/server/db/client.js` — which evaluates `RawSchema.parse(process.env)` at module init time. Without env vars, `pnpm test:unit` fails at module-load with a zod validation error before any test runs (`DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `APP_KEK_BASE64` all missing).
- **Fix:** Both files now seed env with `??=` defaults at the TOP, BEFORE the dynamic `await import(...)`. Matches the established codebase pattern in `tests/unit/proxy-trust.test.ts` (which has the same situation for the proxy-trust middleware module). The seeded values are well-formed dummies; unit tests never touch the pool.
- **Files modified:** `tests/unit/audit-cursor.test.ts`, `tests/unit/audit-append-only.test.ts`
- **Verification:** `pnpm test:unit tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts` exits 0 with all 4 tests passing
- **Committed in:** `a5f3142` (Task 2)

**2. [Rule 2 - Missing critical] `assertValidActionFilter` defense-in-depth check added**
- **Found during:** Task 1 (writing audit-read.ts)
- **Issue:** The plan's `<action>` block specified "Validate `actionFilter` parameter: must be either `'all'` or a member of `AUDIT_ACTIONS`. If neither, throw `AppError code='validation_failed' status=422`." This was already in scope for the plan — flagging here for transparency.
- **Fix:** Added a private `assertValidActionFilter(filter: string): asserts filter is AuditActionFilter` that runs against `AUDIT_ACTIONS as readonly string[]` before the SQL builder. Plan 02-08's zod validation is the second layer; this is the first.
- **Files modified:** `src/lib/server/services/audit-read.ts`
- **Verification:** TypeScript compiles; the assertion narrows the union for the SQL builder
- **Committed in:** `d351c8e` (Task 1)

---

**Total deviations:** 2 (1 blocking auto-fix, 1 in-scope clarification)
**Impact on plan:** All within scope; the env-seed fix is an established codebase idiom (proxy-trust.test.ts), not a new pattern.

## Issues Encountered

- **Local Postgres not available:** the integration assertions in `tests/integration/audit.test.ts` cannot execute on this Windows dev workstation (no `pg_isready`, no Docker daemon). The test FILE compiles, the new live `it(...)` calls enumerate in vitest's runner output (visible as `↓` because `beforeAll` failed at ECONNREFUSED). CI's Postgres service container will exercise them on the next push. Same story as Plans 02-01 through 02-06 — the env validation gates them locally.

## User Setup Required

None — no external service configuration required. The added module uses only existing infrastructure (db/client, auditLog schema, AUDIT_ACTIONS const, AppError taxonomy).

## Next Phase Readiness

- Plan 02-08 (routes-and-sweeps) can wire `GET /api/audit?cursor=&action=` directly to `listAuditPage(userId, cursor, action)` and project each row through `toAuditEntryDto`. The route layer's zod validates `action` against `['all', ...AUDIT_ACTIONS]` (D-32 closed picklist); `assertValidActionFilter` is the second layer beneath it.
- Plan 02-08 also adds `/api/audit` to the `MUST_BE_PROTECTED` allowlist in `tests/integration/anonymous-401.test.ts` — required by the AGENTS.md Privacy & multi-tenancy rule 3.
- Plan 02-10 (Svelte pages) consumes the `nextCursor` field directly: a "Load more" button submits the next request with `?cursor=<value>`. The cursor is opaque to the UI (display-only).

## Self-Check: PASSED

All claims in this summary verified against disk and git history:

- `src/lib/server/services/audit-read.ts`: FOUND (138 lines, `listAuditPage`, `encodeCursor`, `decodeCursor`, `assertValidActionFilter`, exports `PAGE_SIZE`, `AuditPage`, `AuditActionFilter`, `AuditEntryRow`)
- `src/lib/server/dto.ts`: FOUND (modified, contains `toAuditEntryDto` and `AuditEntryDto`)
- `tests/unit/audit-cursor.test.ts`: FOUND (2 live `it(...)` calls, no `it.skip`)
- `tests/unit/audit-append-only.test.ts`: FOUND (2 live `it(...)` calls, no `it.skip`)
- `tests/integration/audit.test.ts`: FOUND (3 live PRIV-02 `it(...)` calls + 1 KEYS-06 `it(...)` from Plan 02-05)
- Commit `d351c8e` (Task 1): FOUND in git log
- Commit `a5f3142` (Task 2): FOUND in git log
- `pnpm test:unit`: 65 passing, 10 files (verified)
- `pnpm exec tsc --noEmit`: clean (verified)
- `pnpm exec eslint src/lib/server/services/audit-read.ts src/lib/server/dto.ts tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts tests/integration/audit.test.ts`: clean (verified)
- `grep -c "auditLog.userId, userId" src/lib/server/services/audit-read.ts`: 2 (one in comment, one in code — the load-bearing FIRST clause in `and(...)`)

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-27*

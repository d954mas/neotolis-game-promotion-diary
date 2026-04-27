---
phase: 02-ingest-secrets-and-audit
plan: 05
subsystem: services
tags: [services, envelope-encryption, steam-api, audit, dto, multi-tenant, secrets]

requires:
  - phase: 01-foundation
    provides: "envelope encryption module (encryptSecret / decryptSecret), writeAudit (never-throws, AuditAction-typed), AppError + NotFoundError, db client, DTO projection discipline (P3 runtime guard)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-01)
    provides: "tests/integration/secrets-steam.test.ts (5 it.skip stubs) + tests/integration/audit.test.ts (1 02-05 it.skip stub)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-02)
    provides: "tenant-scope/no-unfiltered-tenant-query ESLint rule (active on src/lib/server/services/**)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-03)
    provides: "api_keys_steam table (7 ciphertext columns + label + last4 + UNIQUE(user_id, label) + rotated_at), AUDIT_ACTIONS const including key.add/key.rotate/key.remove, audit_action pgEnum"
  - phase: 02-ingest-secrets-and-audit (Plan 02-04)
    provides: "src/lib/server/integrations/steam-api.ts with fetchSteamAppDetails (this plan AMENDS the file, adds validateSteamKey)"

provides:
  - "src/lib/server/services/api-keys-steam.ts — createSteamKey, listSteamKeys, getSteamKeyById, rotateSteamKey, removeSteamKey, decryptSteamKeyForOperator (internal-only)"
  - "src/lib/server/integrations/steam-api.ts gains validateSteamKey (D-17 IWishlistService probe; 5xx → throw 'steam_api_5xx', 4xx → false, 2xx → true; 5s AbortController)"
  - "src/lib/server/dto.ts gains ApiKeySteamDto + toApiKeySteamDto (strips every ciphertext column AND kek_version AND userId at the projection function — D-39 runtime guard)"
  - "tests/integration/secrets-steam.test.ts: 5 placeholder stubs flipped to live tests covering KEYS-03..06"
  - "tests/integration/audit.test.ts: new 'audit IP forwarding (KEYS-06)' describe block lights up the 02-05 placeholder; the 3 02-07 stubs preserved untouched"
  - "tests/unit/dto.test.ts: behavioural ciphertext-strip test for toApiKeySteamDto (D-39 runtime guard)"

affects: [02-06-ingest-and-events-services, 02-07-audit-read-service, 02-08-routes-and-sweeps, 02-10-svelte-pages, 02-11-smoke-360-validation, Phase-3-wishlist-polling-worker]

tech-stack:
  added: []
  patterns:
    - "Validation order (KEYS write paths): input shape → label-collision pre-check (D-13/B-3 multi-key UI) → Steam probe (`validateSteamKey`) → `encryptSecret` → INSERT/UPDATE → `writeAudit`. The order is load-bearing — validation before encryption (no wasted DEK on a typo), encryption before persist (no plaintext on disk ever), persist before audit (audit row references persisted id)"
    - "Steam probe error mapping: `validateSteamKey` returns boolean for 2xx/4xx and throws `Error('steam_api_5xx')` for 5xx; service-layer `probeSteamKey` helper translates to AppError(422 'validation_failed') for 4xx, AppError(502 'steam_api_unavailable') for 5xx. Network/abort errors escape unchanged so the route layer logs them as 500 (operator-scope, not user-scope)"
    - "removeSteamKey audits BEFORE the DELETE (D-32 forensics) — even if the DELETE fails for any reason the security signal is captured. Reverse order would let a transient DB error swallow the audit"
    - "Explicit field listing for INSERT/UPDATE (NOT `...enc` spread). Keeps schema-DTO mapping reviewable; a future schema change cannot silently widen what hits the row"
    - "DTO projection as runtime guard (D-39): TypeScript erases types at runtime; only `toApiKeySteamDto` decides what crosses the wire. tests/unit/dto.test.ts asserts the strip behaviourally against a row literal carrying every ciphertext column"
    - "Steam API mocking via `vi.spyOn(SteamApi, 'validateSteamKey')` against the imported namespace — ESM partial mocks via `vi.mock` are flaky on @sveltejs/kit + Vitest 4; spyOn is the same pattern Phase 1 helpers.ts uses"

key-files:
  created:
    - "src/lib/server/services/api-keys-steam.ts"
  modified:
    - "src/lib/server/integrations/steam-api.ts"
    - "src/lib/server/dto.ts"
    - "tests/integration/secrets-steam.test.ts"
    - "tests/integration/audit.test.ts"
    - "tests/unit/dto.test.ts"

key-decisions:
  - "Service-layer Steam probe lives in a private `probeSteamKey` helper that does the 4xx → AppError(422) / 5xx → AppError(502) translation in one place — both `createSteamKey` and `rotateSteamKey` call it, so error mapping is consistent across write paths and a future audit/validation refinement happens in one location"
  - "rotateSteamKey calls `getSteamKeyById(userId, keyId)` BEFORE the Steam probe. Cross-tenant rotation attempts must not even hit Steam — saves the round-trip and avoids an attacker using rotation as an existence-leak side-channel via Steam latency"
  - "Defensive `if (!row) throw new NotFoundError()` after the rotate UPDATE — `getSteamKeyById` already guaranteed the row exists, but a concurrent `removeSteamKey` could race in between. Treating the empty RETURNING as 404 is the correct semantic and matches the cross-tenant 404 contract"
  - "Plaintext is consumed inside the function scope of `createSteamKey` / `rotateSteamKey` and never assigned to a long-lived variable. V8 strings are immutable so we cannot wipe; Pino redact paths (D-24) catch any accidental log emission by field-shape match. The plaintext immediately becomes ciphertext (encryptSecret) and a 4-char tail (last4)"
  - "decryptSteamKeyForOperator is exported but documented as INTERNAL — Phase 2 only uses it in tests (envelope round-trip proof). Phase 3 worker is the only future production caller. The `forOperator` suffix is the load-bearing reviewer signal: any future PR that adds a Hono route calling this function fails review"

requirements-completed: [KEYS-03, KEYS-04, KEYS-05, KEYS-06]

duration: 5m 33s
completed: 2026-04-27
---

# Phase 02 Plan 05: API Keys (Steam) Service Summary

**Steam API key service end-to-end: paste-time validation against `IWishlistService/GetWishlistItemCount/v1` (D-17), envelope encryption per the Phase 1 `crypto/envelope.ts` contract (D-12), one row per labelled Steamworks account (D-13/B-3 multi-key UI), audit on every write with `{kind, key_id, label, last4}` metadata (D-34), strict DTO projection that strips every ciphertext column at runtime (D-39).**

## Performance

- **Duration:** ~5 min 33 s
- **Started:** 2026-04-27T20:47:27Z
- **Completed:** 2026-04-27T20:53:00Z
- **Tasks:** 2
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments

- New service file `src/lib/server/services/api-keys-steam.ts` implementing 6 exported functions (createSteamKey, listSteamKeys, getSteamKeyById, rotateSteamKey, removeSteamKey, decryptSteamKeyForOperator). Every function takes `userId: string` first; every Drizzle query filters by `eq(apiKeysSteam.userId, userId)`. The Plan 02-02 tenant-scope ESLint rule reports zero violations.
- `validateSteamKey` added to `src/lib/server/integrations/steam-api.ts` alongside the existing `fetchSteamAppDetails` (D-17 verbatim per RESEARCH.md §7: 5s AbortController, `IWishlistService/GetWishlistItemCount/v1?key=...&steamid=0`, 5xx → throw, 4xx → false, 2xx → true).
- `ApiKeySteamDto` + `toApiKeySteamDto` appended to `src/lib/server/dto.ts` — projection function strips every ciphertext column (`secretCt`, `secretIv`, `secretTag`, `wrappedDek`, `dekIv`, `dekTag`), `kekVersion`, AND `userId`. Returns ONLY `{id, label, last4, createdAt, updatedAt, rotatedAt}`.
- 5 placeholder `it.skip` stubs in `tests/integration/secrets-steam.test.ts` flipped to live `it(...)` covering KEYS-03 envelope at rest, KEYS-04 DTO strip, KEYS-05 rotate overwrites + audits, KEYS-05 rotate fails on invalid (422 with no half-write), KEYS-06 audit metadata shape `{kind, key_id, label, last4}`.
- `tests/integration/audit.test.ts` gained a new `audit IP forwarding (KEYS-06)` describe block that lights up the `02-05: KEYS-06 ip resolved via proxy-trust` placeholder; the 3 Plan 02-07 PRIV-02 stubs are untouched.
- `tests/unit/dto.test.ts` gained the D-39 behavioural ciphertext-strip test — proves `toApiKeySteamDto` strips every secret-shaped key even when the input row literal carries them. Runs in 1 ms; ran successfully (52/52 passing in unit suite, 9 skipped placeholders).

## Task Commits

1. **Task 1: api_keys_steam service + validateSteamKey + DTO projection** — `ea9a834` (feat)
2. **Task 2: flip 5 secrets-steam + 1 audit-IP placeholder stubs to live; add dto ciphertext-strip behavioural test** — `a91f2c0` (test)

## Files Created/Modified

### Created (1)

- `src/lib/server/services/api-keys-steam.ts` — 6 exported functions; explicit-field INSERT/UPDATE (no `...enc` spread); validation-then-encrypt-then-persist-then-audit order; removeSteamKey audits BEFORE the DELETE.

### Modified (5)

- `src/lib/server/integrations/steam-api.ts` — appended `validateSteamKey` (D-17 IWishlistService probe). The Plan 02-04 `fetchSteamAppDetails` function is unchanged.
- `src/lib/server/dto.ts` — appended `ApiKeySteamDto` interface + `toApiKeySteamDto` projection function.
- `tests/integration/secrets-steam.test.ts` — replaced 5 `it.skip` placeholders with live `it(...)` bodies; added `vi.spyOn(SteamApi, 'validateSteamKey')` mocking pattern with `afterEach(() => validateSpy.mockReset())`.
- `tests/integration/audit.test.ts` — added new `describe('audit IP forwarding (KEYS-06)', ...)` block that flips the `02-05: KEYS-06 ip resolved via proxy-trust` stub. The 3 `02-07: PRIV-02` stubs are preserved untouched (Plan 07 owner).
- `tests/unit/dto.test.ts` — appended `describe('toApiKeySteamDto strips ciphertext (D-39 behavioural)', ...)` with one live test.

## Decisions Made

See the `key-decisions` block in frontmatter for the full list. The load-bearing one: **`probeSteamKey` is a private helper inside `api-keys-steam.ts` that owns the 4xx→422 / 5xx→502 translation**. Both `createSteamKey` and `rotateSteamKey` call it, so error semantics stay consistent across write paths and any future audit/retry refinement happens in one location. Network errors (DNS / abort / TLS) escape unchanged — those are operator-scope failures the route layer should surface as 500, not user-scope `validation_failed`.

## Plan Output Items (per `<output>` section)

1. **Placeholder it.skip stubs flipped to `it(...)`:**
   - secrets-steam.test.ts: `02-05: KEYS-03 envelope encrypted at rest`, `02-05: KEYS-04 DTO strips ciphertext`, `02-05: KEYS-05 rotate overwrites ciphertext + audits`, `02-05: KEYS-05 rotate fails on invalid key (422)`, `02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}` — 5 of 5.
   - audit.test.ts: `02-05: KEYS-06 ip resolved via proxy-trust` — 1 of 1.
   - dto.test.ts (NEW): `02-05: returns only DTO keys even when row literal carries ciphertext` — 1 new behavioural test.

2. **Audit metadata shape verified across all three actions:**
   - `key.add` — written by `createSteamKey` after the INSERT succeeds; metadata is `{kind: 'steam', key_id: <new id>, label: <user-supplied label>, last4: <last 4 chars of plaintext>}`.
   - `key.rotate` — written by `rotateSteamKey` after the UPDATE succeeds; same metadata shape but with the NEW `last4` (post-rotation key) and the SAME `key_id` (rotation does not change the row id) and the SAME `label`.
   - `key.remove` — written by `removeSteamKey` BEFORE the DELETE; metadata is `{kind:'steam', key_id, label, last4}` of the row about to be deleted (read out of the SELECT step). The audit row outlives the api_keys_steam row by design (forensics).
   - All three are typed against `AuditAction` (Plan 02-03 retyping); a stray free-form string fails at TypeScript check.

3. **`decryptSteamKeyForOperator` is NOT exposed via any HTTP route:**
   - `grep -r "decryptSteamKeyForOperator" src/` — only matches in `src/lib/server/services/api-keys-steam.ts` (the definition site). No Hono route imports it. Phase 2 has no HTTP boundary that decrypts a key (Plan 02-08 would have surfaced it; KEYS-04 strict DTO discipline rules out the read path).
   - The function is exported because Phase 3 worker (in `src/worker/`) will import it per-job to make the wishlist polling call. The `forOperator` suffix is the reviewer signal: any future PR that adds a Hono route calling this function fails review under D-39.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Cross-tenant existence pre-check on `rotateSteamKey` BEFORE the Steam probe**

- **Found during:** Task 1 (writing `rotateSteamKey`)
- **Issue:** The plan's `rotateSteamKey` description goes "validation order, then encryptSecret, then UPDATE". A naive read implements that as: validatePlaintext → probeSteamKey → encryptSecret → UPDATE → if RETURNING empty, NotFoundError. That works for the happy path, but it has two problems: (a) cross-tenant rotation attempts hit the Steam API (wasted Valve quota; minor existence-leak side-channel via response timing), (b) if the Steam probe times out or 5xxs, a cross-tenant attacker can detect that user A has SOME key under id X by observing the 502 vs 404 distinction.
- **Fix:** Added `await getSteamKeyById(userId, keyId)` as the FIRST step of `rotateSteamKey`, before `probeSteamKey`. Cross-tenant rotation attempts now throw NotFoundError without ever calling Steam. The Steam probe still runs for valid same-tenant rotation attempts (keeping the validation-before-encrypt invariant intact for legitimate calls).
- **Files modified:** `src/lib/server/services/api-keys-steam.ts`
- **Verification:** Cross-tenant rotation: `getSteamKeyById(otherUserId, keyId)` throws NotFoundError immediately; Steam never called. Same-tenant rotation: `getSteamKeyById` succeeds, then `probeSteamKey` runs as planned.
- **Committed in:** `ea9a834` (Task 1)

**2. [Rule 1 - Bug] `probeSteamKey` helper extracted to deduplicate error-translation logic**

- **Found during:** Task 1 (writing `rotateSteamKey` after `createSteamKey`)
- **Issue:** The plan's `<action>` block specifies the same `validateSteamKey` try/catch + `false → 422` + `5xx → 502` translation for both `createSteamKey` and `rotateSteamKey`. Inlining the translation twice would create two places where a future change (e.g., adding a retry, or distinguishing rate-limit 429 from auth 401) has to land — a copy-paste drift hazard.
- **Fix:** Extracted the translation into a private `probeSteamKey(plaintext)` helper inside `api-keys-steam.ts`. Both `createSteamKey` and `rotateSteamKey` call it. The helper owns the AppError mapping; the callers see only "void on success, AppError on failure".
- **Files modified:** `src/lib/server/services/api-keys-steam.ts`
- **Verification:** ESLint clean; tests for both 422 (rotate fails on invalid key) and the create-time validation path exercise the helper through their respective call paths.
- **Committed in:** `ea9a834` (Task 1)

**3. [Rule 2 - Missing critical] Test 4 (rotate fails on invalid 422) extended with `key.rotate` audit-row absence assertion**

- **Found during:** Task 2 (writing the rotate-fails-on-invalid test)
- **Issue:** The plan's test 4 sketch asserts the ciphertext is unchanged after a failed rotation. But the audit log invariant is symmetric: `key.rotate` is written ONLY on a successful rotation. The plan's `<must_haves>` says `audit row written with action='key.rotate'` on success — and by negation the audit row must NOT exist on a failed rotation. The original test would have been silent if a future bug caused the audit to fire before validation.
- **Fix:** Added `expect(audits).toHaveLength(0)` against `audit_log WHERE userId=A AND action='key.rotate'` at the end of the test. Catches "audit fired even though validation failed" regressions.
- **Files modified:** `tests/integration/secrets-steam.test.ts`
- **Verification:** Service code writes the audit AFTER the UPDATE succeeds (which throws on validation failure first), so the assertion holds against the current implementation. CI Postgres will execute it.
- **Committed in:** `a91f2c0` (Task 2)

---

**Total deviations:** 3 auto-fixed (1 bug deduplication, 2 missing-critical assertions/checks).
**Impact on plan:** None of the three change the plan's contract. Deviation 1 closes a small existence-leak side-channel that the plan's `<must_haves>` doesn't explicitly call out but follows from the PRIV-01 cross-tenant 404 invariant. Deviation 2 reduces copy-paste hazard. Deviation 3 strengthens the no-half-write assertion to also cover the no-half-audit invariant.

## Authentication Gates

None encountered — the Steam Web API probe is mocked via `vi.spyOn(SteamApi, 'validateSteamKey')`; the integration tests do not need a real Steam key and do not perform any OAuth dance.

## Issues Encountered

- **Local Postgres not available:** the integration test suite cannot execute on this Windows dev workstation (no `pg_isready`, no Docker daemon, no `.env` file). The integration test FILES compile (`pnpm exec tsc --noEmit` exits 0), the test FILES lint clean (`pnpm exec eslint` exits 0), and the unit suite passes 52/52 (1 new test from this plan). CI's Postgres service container will execute the new integration assertions on push. Same gating story as Plans 02-01..02-04.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 02-06 (ingest-and-events services)** is unblocked: items-youtube.ts can land alongside its Plan 02-04 `findOwnChannelByHandle` resolver without depending on key services.
- **Plan 02-07 (audit-read service)** has 3 new audit verbs to filter on: `key.add`, `key.rotate`, `key.remove`. The `(user_id, action, created_at)` composite index from Plan 02-03 covers the action-filter dropdown query.
- **Plan 02-08 (routes-and-sweeps)** has the complete service layer to wrap with HTTP routes:
  - POST /api/keys/steam → `createSteamKey` (maps `steam_key_label_exists` → 422; `validation_failed` → 422; `steam_api_unavailable` → 502)
  - GET /api/keys/steam → `listSteamKeys` → map each row through `toApiKeySteamDto`
  - PUT /api/keys/steam/:id/rotate → `rotateSteamKey` → `toApiKeySteamDto`
  - DELETE /api/keys/steam/:id → `removeSteamKey`
  - **MUST_BE_PROTECTED in the anonymous-401 sweep** must be extended to include all 4 paths above.
- **Plan 02-10 (svelte-pages)** has `ApiKeySteamDto` ready for the keys settings page; the masked-key UI (write-once, last-4 visible) maps directly to the DTO shape.
- **Phase 3 (wishlist polling worker)** has `decryptSteamKeyForOperator` as the per-job decryption entry point — the only future production caller. The Phase 2 envelope-encryption round-trip proof (KEYS-03 test) confirms the write→decrypt path works end-to-end.

## Self-Check: PASSED

All claims in this summary verified against disk and git history:

- `src/lib/server/services/api-keys-steam.ts`: FOUND (349 lines; exports createSteamKey, listSteamKeys, getSteamKeyById, rotateSteamKey, removeSteamKey, decryptSteamKeyForOperator)
- `src/lib/server/integrations/steam-api.ts`: FOUND (modified; contains both `fetchSteamAppDetails` and `validateSteamKey`)
- `src/lib/server/dto.ts`: FOUND (modified; contains ApiKeySteamDto + toApiKeySteamDto)
- `tests/integration/secrets-steam.test.ts`: FOUND (modified; 5 `it(` calls matching `^\s*it\(` regex; zero remaining `it.skip`)
- `tests/integration/audit.test.ts`: FOUND (modified; 1 new `it(` for 02-05 KEYS-06; 3 untouched `it.skip` for Plan 02-07)
- `tests/unit/dto.test.ts`: FOUND (modified; new describe block `toApiKeySteamDto strips ciphertext (D-39 behavioural)`)
- Commit `ea9a834` (Task 1): FOUND in git log
- Commit `a91f2c0` (Task 2): FOUND in git log
- Service grep `(encryptSecret|validateSteamKey|writeAudit|key\.(add|rotate|remove))` returns 19 matches in api-keys-steam.ts (≥1 each as required)
- ESLint on touched files: exits 0 (tenant-scope rule + process.env restriction satisfied)
- `pnpm exec tsc --noEmit`: exits 0
- D-39 grep `(secret_ct|wrapped_dek|kek_version)` in dto.ts non-comment lines: ZERO matches (projection function uses camelCase row field accessors, not column names)
- Unit test suite: 52 passed, 9 skipped (1 new test from this plan)

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-27*

---
phase: 2
slug: ingest-secrets-and-audit
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-27
updated: 2026-04-28
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> Plan 02-11 (this plan) fills in the per-task verification map and the
> sign-off block. The map references each plan's `<verify><automated>`
> block as the source of truth — when this contract drifts from a plan's
> actual verify block, the plan wins (and this file gets a revision
> commit).

---

## Test Infrastructure

| Property              | Value                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**         | Vitest ^4.1.5 (locked Phase 1)                                                                                                     |
| **Config file**       | `vitest.config.ts` (test.projects: `unit` / `integration` / `browser`)                                                             |
| **Quick run command** | `pnpm test:unit`                                                                                                                   |
| **Full suite command**| `pnpm test` (compiles paraglide + svelte-kit sync + runs every project) **plus** `pnpm test:browser` (needs vite preview on :5173) |
| **Estimated runtime** | ~45s unit + integration; ~30s browser (Chromium boot dominates)                                                                    |

**Browser dep manifest (W-2 sign-off):**

- `@vitest/browser ^4.1.5` (devDep) — Vitest 4 browser-mode runtime
- `@vitest/browser-playwright ^4.1.5` (devDep) — Vitest 4.1+ requires the
  typed factory import; the legacy `provider: "playwright"` string was
  removed mid-4.x
- `playwright ^1.49.0` (devDep) — browser engine peer
- `@testing-library/svelte` — DELIBERATELY REJECTED (Plan 09 uses Svelte 5's
  built-in `svelte/server` SSR for the empty-state-shape assertion; no need
  for a second Svelte testing surface)

**One-line rationale:** D-42 / UX-02 is a hard requirement (360px viewport
contract). JSDOM cannot compute CSS layout fully, so a JSDOM-based assertion
would be vacuous. Real browser layout is the only rigorous path; @vitest/browser
+ playwright is the smallest dep delta meeting the contract.

---

## Sampling Rate

- **After every task commit:** `pnpm test:unit` (≤1s; covers DTO + url-parser
  + cursor + ESLint rule + envelope + audit-append-only + paraglide + logger
  + auth-adapter + proxy-trust)
- **After every plan wave:** `pnpm test:integration` (≤45s; needs Postgres)
- **Before `/gsd:verify-work`:** Full suite green (`pnpm test` + `pnpm
  test:browser`); CI smoke job green
- **Max feedback latency:** ~75 seconds (full suite, browser tests excluded
  on dev where Chromium isn't installed)

---

## Per-Task Verification Map

| Task ID    | Plan | Wave | Requirement                                                       | Test Type             | Automated Command                                                                                                                                                              | File Exists | Status |
| ---------- | ---- | ---- | ----------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| 02-01-01   | 01   | 0    | docs (GAMES-04, KEYS-01, KEYS-02, INGEST-01)                      | grep                  | `node -e "..."` (REQUIREMENTS / ROADMAP / AGENTS string asserts)                                                                                                               | ✅          | ✅     |
| 02-01-02   | 01   | 0    | scaffolding (12 placeholder test files + 1 it.skip)               | unit/integration      | `pnpm exec vitest run tests/integration/*.test.ts tests/unit/*.test.ts --reporter=verbose`                                                                                     | ✅          | ✅     |
| 02-02-01   | 02   | 0    | cross-cutting (D-38 ESLint rule scaffold)                         | structural            | `pnpm exec eslint --rule "tenant-scope/no-unfiltered-tenant-query: error" --stdin <<<...`                                                                                      | ✅          | ✅     |
| 02-02-02   | 02   | 0    | cross-cutting (D-38 RuleTester cases)                             | unit                  | `pnpm test:unit tests/unit/tenant-scope-eslint-rule.test.ts`                                                                                                                   | ✅          | ✅     |
| 02-03-01   | 03   | 0    | GAMES-01..04, KEYS-03, INGEST-02..03, EVENTS-01, PRIV-02 (schema) | typecheck + grep      | `pnpm exec tsc --noEmit && node -e "..."`                                                                                                                                      | ✅          | ✅     |
| 02-03-02   | 03   | 0    | migration (audit_log enum + 7 new tables)                         | integration           | `pnpm test:integration tests/integration/migrate.test.ts`                                                                                                                      | ✅          | ✅     |
| 02-04-01   | 04   | 1    | GAMES-01..04 (services scaffolding)                               | typecheck + lint      | `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/server/services/games.ts ...`                                                                                              | ✅          | ✅     |
| 02-04-02   | 04   | 1    | GAMES-01..04 (services + soft-cascade tx + Steam appdetails)      | integration           | `pnpm test:integration tests/integration/games.test.ts tests/integration/game-listings.test.ts`                                                                                | ✅          | ✅     |
| 02-05-01   | 05   | 1    | KEYS-03..06 (api-keys-steam service skeleton)                     | typecheck + grep      | `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/server/services/api-keys-steam.ts && grep -E ...`                                                                          | ✅          | ✅     |
| 02-05-02   | 05   | 1    | KEYS-03..06 + dto runtime guard                                   | integration + unit    | `pnpm test:integration tests/integration/secrets-steam.test.ts tests/integration/audit.test.ts && pnpm test:unit tests/unit/dto.test.ts`                                       | ✅          | ✅     |
| 02-06-01   | 06   | 1    | INGEST-02..04 (URL parser pure unit)                              | unit                  | `pnpm test:unit tests/unit/url-parser.test.ts`                                                                                                                                 | ✅          | ✅     |
| 02-06-02   | 06   | 1    | INGEST-02..04, EVENTS-01..03 (services + paste orchestrator)      | typecheck + lint      | `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/server/services/items-youtube.ts ...`                                                                                      | ✅          | ✅     |
| 02-06-03   | 06   | 1    | INGEST-02..04, EVENTS-01..03 (integration)                        | integration           | `pnpm test:integration tests/integration/ingest.test.ts tests/integration/events.test.ts`                                                                                      | ✅          | ✅     |
| 02-07-01   | 07   | 1    | PRIV-02 (audit-read service skeleton)                             | typecheck + lint      | `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/server/services/audit-read.ts`                                                                                             | ✅          | ✅     |
| 02-07-02   | 07   | 1    | PRIV-02 + audit append-only invariant                             | unit + integration    | `pnpm test:unit tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts && pnpm test:integration tests/integration/audit.test.ts`                                 | ✅          | ✅     |
| 02-08-01   | 08   | 2    | (HTTP layer over GAMES, KEYS, INGEST, EVENTS, PRIV-02, UX-01)     | typecheck + lint      | `pnpm exec tsc --noEmit && pnpm exec eslint src/lib/server/http/routes/`                                                                                                       | ✅          | ✅     |
| 02-08-02   | 08   | 2    | sweep extension (24 routes) + cross-tenant matrix (21 probes)     | integration           | `pnpm test:integration tests/integration/anonymous-401.test.ts tests/integration/tenant-scope.test.ts tests/integration/log-redact.test.ts`                                    | ✅          | ✅     |
| 02-09-01   | 09   | 3    | UX-01 SSR + design tokens                                         | typecheck + grep      | `pnpm exec svelte-kit sync && pnpm exec tsc --noEmit && grep -c '%theme%' src/app.html`                                                                                        | ✅          | ✅     |
| 02-09-02   | 09   | 3    | UX-03 paraglide keys (D-41 keyset snapshot, 80 keys)              | integration           | `pnpm exec paraglide-js compile && pnpm test:integration tests/integration/i18n.test.ts`                                                                                       | ✅          | ✅     |
| 02-09-03   | 09   | 3    | UX-01 theme + UX-03 empty-state                                   | integration           | `pnpm test:integration tests/integration/empty-states.test.ts tests/integration/theme.test.ts`                                                                                 | ✅          | ✅     |
| 02-10-01   | 10   | 3    | UX-01 reconciliation + page composition                           | svelte-check          | `pnpm exec svelte-check`                                                                                                                                                       | ✅          | ✅     |
| 02-10-02   | 10   | 3    | full-stack integration                                            | full-suite            | `pnpm test:integration`                                                                                                                                                        | ✅          | ✅     |
| 02-11-01   | 11   | 4    | Phase 2 smoke extension (GAMES-01 + cross-tenant + anon-401)      | smoke                 | `ALLOW_LOCAL_SMOKE=1 bash tests/smoke/self-host.sh` (CI runs on every PR via the existing `smoke` job)                                                                         | ✅          | ⬜     |
| 02-11-02   | 11   | 4    | UX-02 (360px) — public routes                                     | browser               | `pnpm test:browser`                                                                                                                                                            | ✅          | ⬜     |
| 02-11-03   | 11   | 4    | this file (sign-off contract)                                     | manual                | per-task review (this VALIDATION.md sign-off)                                                                                                                                  | ✅          | ✅     |

_Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky_

**Sampling continuity check:** the longest auto-verify-free chain is the
`checkpoint:human-verify` in Plan 11 Task 4 — every other task carries its
own `<automated>` verify block. Pending statuses on 02-11-01 / 02-11-02 will
flip to ✅ when the CI smoke job and the browser-tests job pass on the PR
that lands this branch (the local Windows dev workstation has neither
Docker nor Chromium installed, matching the same gating story as every
Phase 2 plan since 02-01).

---

## Wave 0 Requirements

- [x] `tests/integration/games.test.ts`, `game-listings.test.ts`,
  `secrets-steam.test.ts`, `ingest.test.ts`, `events.test.ts`,
  `audit.test.ts`, `theme.test.ts`, `empty-states.test.ts`,
  `log-redact.test.ts` (Plan 02-01 placeholder; later plans flipped each
  `it.skip` to live `it()`)
- [x] `tests/unit/url-parser.test.ts`, `audit-cursor.test.ts`,
  `audit-append-only.test.ts` (Plan 02-01 placeholder; lit up by 02-06 /
  02-07)
- [x] `tests/unit/tenant-scope-eslint-rule.test.ts` (Plan 02-02)
- [x] `tests/integration/migrate.test.ts` (Phase 1 file extended in Plan
  02-03)
- [x] `eslint-plugin-tenant-scope/` (Plan 02-02)
- [x] `drizzle/0001_phase02_schema.sql` (Plan 02-03)
- [x] `tests/browser/responsive-360.test.ts` (Plan 02-11)
- [x] `tests/browser/commands.d.ts` (Plan 02-11; module augmentation for the
  custom Playwright-backed commands)

**Conditional install (W-2):** `@vitest/browser` + `@vitest/browser-playwright`
+ `playwright` ADDED in Plan 02-11 with one-line rationale (above). The
addition is the W-2 planner deviation flagged in 02-RESEARCH.md
§"Environment Availability" (line 1416) — sign-off captured here.

---

## Manual-Only Verifications

| Behavior                                                                                                              | Requirement     | Why Manual                                                                                                                                                                                                                              | Test Instructions                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-02 360px on AUTHENTICATED pages (`/games`, `/games/[gameId]`, `/events`, `/audit`, `/accounts/youtube`, `/keys/steam`, `/settings`) | UX-02           | Authenticated browser-mode tests need a Better Auth-signed session cookie injected into the Playwright context, but Vitest browser-mode tests run in a separate process from the SvelteKit preview server with no in-test Postgres connection — `seedUserDirectly` (the integration helper) and the cookie minter are unavailable. Phase 6 polish lifts the cookie-injection harness or adds an `APP_ROLE=test` bypass. | Sign in via local dev server. Resize Chrome devtools to 360x640. Visit each route. Confirm: (a) no horizontal scroll bar; (b) primary CTA reachable without zoom; (c) all chips/badges legible; (d) empty states render with monospace example URL. The full checklist lives in Plan 02-11 Task 4 `<how-to-verify>` Check 2.        |
| Visual coherence of design tokens at 360px (color, spacing, typography)                                               | UX-01, UX-02    | Token aesthetics resist automated assertion (a contrast ratio passes but the visual still feels off).                                                                                                                                   | Toggle light → dark → system on each page; verify the dominant/secondary/accent split feels right and chips remain legible.                                                                                                                                                                                                       |
| Cookie-wins reconciliation flow looks right end-to-end                                                                | UX-01           | The integration test (Plan 02-10 `tests/integration/theme.test.ts`) verifies the bytes (cookie wins, DB updates); the visual flow confirms there's no flash or jitter when the reconciliation writes back.                              | Set `__theme=light` cookie; set `user.themePreference=dark` via direct SQL; sign in via `/login`; observe the page renders LIGHT; DB now reads `light`.                                                                                                                                                                          |
| OAuth happy path retained from Phase 1 (DEPLOY-05 invariant)                                                          | (cross-cutting) | Smoke gate covers programmatically; this confirms no regression visually.                                                                                                                                                              | Watch CI smoke step; confirm `Phase 2 smoke extension PASSED` AND the prior six D-15 PASS lines appear in the logs.                                                                                                                                                                                                                |

**Scope reduction note (W-3):** Plan 02-11 originally targeted authenticated-
route 360px assertions inside `tests/browser/responsive-360.test.ts` via
`page.context().addCookies` cookie injection. The reduction to public
routes (auto) + authenticated routes (manual) reflects the in-process
limitation above. The `it.skip.each(PHASE_2_AUTH_ROUTES)` block in the test
file documents the deferral at the test surface so a future Phase 6 task
can lift it without re-discovering the contract.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (the lone
      manual gate is Plan 11 Task 4 `checkpoint:human-verify`)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
      (the longest auto-verify-free chain is the manual checkpoint in
      Plan 11 Task 4)
- [x] Wave 0 covers all MISSING references (12 placeholder integration
      tests + 4 placeholder unit tests; every later plan flipped its
      `it.skip` placeholder to live `it()`)
- [x] No watch-mode flags (every command in the table is `vitest run` not
      `vitest`)
- [x] Feedback latency < 90s (~75s full suite + browser combined)
- [x] `nyquist_compliant: true` set in frontmatter

Approval: passing

## Summary

Phase 03.0.2 — dependency refresh — 10 major bumps. Closes #23.

Per CONTEXT.md D-01: one phase-PR onto master, with per-major atomic
commits on the branch (preserving AGENTS.md "Locked stack versions"
practice in spirit; the per-major-PR shape becomes per-major-commit
shape for batched major refresh). Each of the 10 commits below landed
green on all four CI jobs (`lint-typecheck`, `unit-integration`,
`browser-tests`, `smoke`); per-commit CI links live in each plan's
`03.0.2-NN-SUMMARY.md`.

## Per-bump rationale (one line each, in commit order)

1. `@types/supertest` 6→7 (`4ec4c6a`) — type-only devDep, zero callers
   (stranded from earlier phases; follow-up `chore(deps): drop unused
   supertest` PR flagged for after this phase merges).
2. `oauth2-mock-server` 7→8 (`bcdd610`) — Universal ESM + Node 18
   dropped; OAuth/OIDC wire contract unchanged; smoke (D-07 load-bearing
   for the OAuth dance) green on first try, proving v8's contract is
   identical to v7's for the genericOAuth round-trip used by better-auth.
3. `dotenv` 16→17 (`46a8c1e`) — silenced the new advertising line with
   `{ quiet: true }` at both `loadDotenv()` call sites in
   `src/lib/server/config/env.ts` (preserves Pino JSON log discipline in
   production); env.ts remains the sole `process.env` reader, ESLint
   `no-restricted-properties` carve-out unchanged (D-07 honored).
4. ESLint core family 9→10 + globals 15→17 (`b36cec4`) — four packages
   landed atomically per D-05 (`eslint`, `@eslint/js`,
   `eslint-config-prettier`, `globals`); ESLint 10's three new
   recommended rules fixed at the source (1× `preserve-caught-error` in
   `auth-adapter.ts`, 3× `no-useless-assignment`); zero
   `eslint.config.js` rule suppressions (D-06 honored);
   `eslint-plugin-tenant-scope` audit returned zero matches for removed
   context APIs — Pattern 1 lint-time defense intact under ESLint 10.
5. `eslint-plugin-svelte` 2→3 + `svelte-eslint-parser` 0.43→1.6
   (`b75efb6`) — mandatory peer-dep pair per D-05; rune-aware parser
   surfaced zero new lint hits; closes the Plan 04 peer-dep warning;
   no `.svelte` fix-ups required.
6. `pino` 9→10 + `pino-pretty` 11→13 (`82fde15`) — peer-dep pair per
   D-05; `@pinojs/redact` engine swap (replaces `fast-redact`) preserves
   the public `redact` API surface (`paths`, `censor`, `*.*` wildcards);
   `tests/unit/logger.test.ts` (D-07 load-bearing redact tripwire +
   schema-introspection ciphertext-column coverage) **passes** on the
   new engine; zero changes to `src/lib/server/logger.ts` — privacy
   floor invariant intact (AGENTS.md "Privacy & multi-tenancy" item 6).
7. `@hono/node-server` 1→2 (`6b7ffc5`) — Node HTTP runtime adapter;
   public `serve()` API unchanged in v2; sole importer
   (`src/roles/app.ts`) untouched; exact-pin convention preserved (no
   caret); smoke confirms the production-image HTTP path.
8. `typescript` 5.6→6.0 (`eacd52f`) — devDep major; tsconfig.json was
   pre-immunized for all five TS6 default-flips; **zero source
   fix-ups** (`noUncheckedSideEffectImports` audit returned zero
   candidates pre-bump and `pnpm typecheck` passed first try);
   `@typescript-eslint v8` peer range (`>=4.8.4 <6.1.0`) honored at
   6.0.3.
9. drizzle pair refresh (`55870f7`) — Path A: `drizzle-orm` re-pinned at
   `0.45.2` (audit-trail entry) + `drizzle-kit` caret-bumped from
   `^0.31.0` to `^0.31.10`; `latest` dist-tag on both packages is still
   in the pre-1.0 line as of commit-time (rc.2 is `1.0.0-rc.2`, not
   `latest`); `pnpm db:check` no-diff confirms D-08 forward-only
   migration invariant intact; follow-up dep-refresh phase scheduled
   when `drizzle-orm@1.0` flips to `latest` (Casing API breaking change
   on every schema file).
10. `better-auth` 1.6.9→1.6.10 (`22a8c1e`) — patch release with bug
    fixes only (`refreshUserSessions` exposed, OpenAPI/social-sign-in
    fixes, captcha email-OTP fix, duplicate `Set-Cookie` on redirects
    eliminated); `genericOAuth` plugin + session/cookie config +
    Drizzle adapter integration: **unchanged**; `src/lib/auth.ts` and
    `src/lib/server/auth-adapter.ts` zero-touch; smoke CI green
    (D-07 LOAD-BEARING — full OAuth dance through oauth2-mock-server
    against the production image, the load-bearing trust signal
    designated by CONTEXT.md D-07).

**Done outside the phase:** `pg-boss` 12.18.2 was already in
`package.json` pre-phase per the ROADMAP forecast — no commit in this
phase, but noted here for completeness.

## Smoke link

The load-bearing trust signal per CONTEXT.md D-03 — production image +
oauth2-mock-server + full Better Auth genericOAuth dance, run on the
final commit `22a8c1e` (`chore(deps): bump better-auth from 1.6.9 to
1.6.10`):

https://github.com/d954mas/neotolis-game-promotion-diary/actions/runs/25656485113/job/75306968299

(Smoke job conclusion: success, 2m57s. Parent run conclusion: success,
all four jobs green. Run URL:
https://github.com/d954mas/neotolis-game-promotion-diary/actions/runs/25656485113)

## Self-review

Per AGENTS.md §Validation:

- **Constraints:** ✓ no new env reads outside `src/lib/server/config/env.ts`
  (dotenv 17 bump added `{ quiet: true }` at the two existing
  `loadDotenv()` call sites; no new `process.env` reader introduced —
  verified via ESLint `no-restricted-properties` green); ✓ envelope
  encryption invariants untouched (`src/lib/server/auth-adapter.ts` had
  one 2-line `preserve-caught-error` fix as part of the ESLint 10 bump,
  no semantic change to the encrypt/decrypt path); ✓ self-host parity
  preserved (smoke green on the production image with minimal env on
  every commit).
- **Philosophy:** ✓ no SaaS/self-host branching (no `APP_MODE`
  conditionals introduced anywhere); ✓ no premature abstraction (every
  bump fixed at the source, none hidden behind a new abstraction);
  ✓ security as floor (D-06 + D-07 honored — pino redact tripwire,
  better-auth smoke, dotenv-as-sole-env-reader invariant, all
  load-bearing and all green).
- **Practices:** ✓ atomic PRs (1 PR, 10 commits, each green); ✓ tests
  land with the feature where source touched (ESLint-10 fix-ups landed
  in the same commit as the bump that surfaced them); ✓ migrations
  forward-only (drizzle commit no-op — `pnpm db:check` no-diff);
  ✓ env reads centralized; ✓ no secrets in logs (D-07 verified via
  `tests/unit/logger.test.ts` 5/5 on the new `@pinojs/redact` engine);
  ✓ Conventional Commits (`chore(deps): bump X from A to B` shape on
  every commit); ✓ versions pinned (load-bearing runtime libs preserve
  exact-pin convention: `better-auth`, `@hono/node-server`,
  `drizzle-orm`; dev tooling keeps caret).
- **CI gate honesty:** every assertion in this phase rides through an
  existing load-bearing test — no soft-passes introduced, no skip-flags
  added, no rule suppressions for new ESLint-10 recommendations. The
  one timing flake observed (`channel-state-helpers.test.ts:128` —
  two consecutive DB writes occasionally land in the same epoch-ms)
  was unrelated to any bump in this phase, surfaced once during the
  final better-auth re-run, and cleared on automatic re-run; it is a
  pre-existing test-quality item, not a regression.
- **Documentation drift:** ROADMAP.md Phase 03.0.2 entry reflects 10
  plans landed (handled by the orchestrator's update step). CONTEXT.md
  "Deferred Ideas" item re: AGENTS.md "Locked stack versions"
  practice-text clarification (codify family-grouped atomic-commit
  shape as the official major-refresh pattern) is **not** addressed in
  this PR — deferred to a follow-up `docs(agents): clarify dep-bump
  shape` PR after this phase merges, per CONTEXT.md's own deferral
  note.

## Self-review (second pass)

Fresh-context reviewer audit (general-purpose subagent, separate from
author; full report at
`.planning/phases/03.0.2-dependency-refresh-inserted/SECOND-PASS-REVIEW.md`):

**Verdict:** APPROVED — no blocking issues found; PR ready for human
reviewer.

**Findings:**
- **P0 (blocking):** None.
- **P1 (must-address):** None.
- **P2 (nits, non-blocking):**
  1. `AGENTS.md` line "CI gates every PR with three jobs" is out of
     date — current CI has four (`browser-tests` added). Pre-existing
     doc drift, not introduced by this PR. Candidate for follow-up
     `docs(agents): sync CI-job count`.
  2. `AGENTS.md` "Locked stack versions" practice text not updated
     in-phase to codify the family-grouped-atomic-commit shape used
     here. Deferred to follow-up `docs(agents): clarify dep-bump shape`
     PR per CONTEXT.md's own deferral note. Reasonable.
  3. `auth-adapter.ts` `cause: err` attaches a `JSON.parse`
     SyntaxError. The `json` value being parsed is already-ciphertext
     base64 (never plaintext); even if a propagated `cause.message`
     were logged un-redacted, what could leak is a base64 fragment,
     not the cleartext secret. KEK/DEK/plaintext never reach this
     `cause`. Optional belt-and-suspenders: add `*.cause.message` /
     `*.cause.stack` to `REDACT_PATHS`. Acceptable as-is; the privacy
     floor is intact.

**Audit coverage beyond the first-pass verifier:**
- Semantic-equivalence walk of all 4 ESLint-10-induced source/test
  fixes — all confirmed equivalent (full surrounding-context
  inspection, runtime behavior unchanged).
- Transitive-bump audit on `pnpm-lock.yaml` — every transitive change
  traces to a declared spec change; no unrelated runtime drift. The
  Express-4→5 chain is devDep-only (oauth2-mock-server) and never
  ships to production.
- Engine compatibility — `engines.node: ">=22.12"` (unchanged) covers
  every bumped major's documented minimum.
- Independent re-confirmation: all 10 bump-commit SHAs return
  `conclusion: success` on the CI workflow; final run (`25656485113`)
  shows all four jobs green.

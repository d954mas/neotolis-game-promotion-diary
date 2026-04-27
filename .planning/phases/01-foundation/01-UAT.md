---
status: complete
phase: 01-foundation
source:
  - 01-01-SUMMARY.md
  - 01-02-SUMMARY.md
  - 01-03-SUMMARY.md
  - 01-04-SUMMARY.md
  - 01-05-SUMMARY.md
  - 01-06-SUMMARY.md
  - 01-07-SUMMARY.md
  - 01-08-SUMMARY.md
  - 01-09-SUMMARY.md
  - 01-10-SUMMARY.md
ci_evidence:
  master_head: 6af09c80
  pr_merged: "#6 Post Phase 1 review: P0/P1 fixes"
  conclusion: success
  jobs: [lint-typecheck, unit-integration, smoke]
  ratified: 2026-04-27T17:06:01Z
started: 2026-04-27T22:30:00Z
updated: 2026-04-27T22:35:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: |
  Production Docker image boots from scratch in all three roles (APP_ROLE=app/worker/scheduler).
  CI evidence: smoke job green on master 6af09c80 (PR #6); D-15 assertions #1/#2/#3 covered.
result: pass

### 2. Google OAuth Sign-In Flow
expected: |
  User signs in via Google OAuth (genericOAuth plugin with discoveryUrl, INFO I2 Path 2); dashboard renders "Promotion diary".
  CI evidence: smoke D-15 #4 green on master 6af09c80; integration auth.test.ts ("returning user resumes") passes.
result: pass

### 3. Sign-Out Invalidates Session
expected: |
  Better Auth sign-out (and sign-out-all-devices) invalidates server-side sessions; protected pages redirect to /login.
  CI evidence: integration auth.test.ts ("invalidateSession", "all devices") pass on master 6af09c80.
result: pass

### 4. Anonymous-401 Sweep
expected: |
  Every endpoint outside the explicit allowlist refuses anonymous traffic with 401; MUST_BE_PROTECTED guard prevents vacuous-pass.
  CI evidence: smoke D-15 #5a green on master 6af09c80; integration anonymous-401.test.ts passes.
result: pass

### 5. Cross-Tenant 404 Sentinel
expected: |
  User A cannot read user B's resources; HTTP boundary returns 404 (never 403); double-eq(userId) WHERE clause encodes Pattern 3.
  CI evidence: smoke D-15 #5b green on master 6af09c80; integration tenant-scope.test.ts (VALIDATION 7 active; 8/9 deferred to Phase 2) passes.
result: pass

### 6. DTO Discipline (Secret Redaction)
expected: |
  toUserDto / toSessionDto strip googleSub/refreshToken/accessToken/idToken/password/emailVerified; Pino redacts 14 D-24 paths.
  CI evidence: unit dto.test.ts (P3 behavioral tripwire) passes on master 6af09c80; structural grep tripwire on dto.ts asserts the literal strings absent.
result: pass

### 7. Envelope Encryption Round-Trip + Tamper Detection
expected: |
  AES-256-GCM KEK→DEK round-trip, tamper detection (4 fields), missing-KEK fail-fast, rotateDek byte-identical secretCt.
  CI evidence: 11 vitest cases in encryption.test.ts pass on master 6af09c80 (RT1-3, U1, T1-4, B1, R1-2).
result: pass

### 8. i18n m.* Threading (Paraglide)
expected: |
  Paraglide JS 2 single-file dictionary; every src/routes/*.svelte uses m.* exclusively; locale-add invariant asserted.
  CI evidence: locale-add snapshot test passes on master 6af09c80; smoke D-15 #4 confirms "Promotion diary" rendered through Paraglide.
result: pass

### 9. Self-Host Parity (No SaaS-Only Env)
expected: |
  Production image boots with minimal env; no CF_*/CLOUDFLARE_*/ANALYTICS_* required; SaaS-leak source grep gate.
  CI evidence: smoke D-15 #6 green on master 6af09c80; SaaS-leak source grep step passes.
result: pass

### 10. Trusted-Proxy Middleware (CVE-2026-27700)
expected: |
  proxyTrust honors XFF / CF-Connecting-IP / X-Forwarded-Proto only when socket peer is in TRUSTED_PROXY_CIDR; PT1-PT6 covered.
  CI evidence: 6 PT1-PT6 unit tests + 7 helper tests pass on master 6af09c80.
result: pass

## Summary

total: 10
passed: 10
issues: 0
pending: 0
skipped: 0

## Gaps

[none — all tests pass via CI evidence on master 6af09c80]

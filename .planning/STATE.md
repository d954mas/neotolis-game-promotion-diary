---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Ready to execute
stopped_at: Completed 02-03-schema-and-migration-PLAN.md
last_updated: "2026-04-27T20:32:41.762Z"
last_activity: 2026-04-27
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 21
  completed_plans: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Replace messy Google Sheets / markdown files with a structured, secure, query-friendly diary so an indie developer can see — at a glance — which promotion actions actually moved the needle on wishlists and engagement.
**Current focus:** Phase 02 — ingest-secrets-and-audit

## Current Position

Phase: 02 (ingest-secrets-and-audit) — EXECUTING
Plan: 4 of 11

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01-foundation P01 | 3min | 2 tasks | 14 files |
| Phase 01-foundation P02 | 14min | 2 tasks | 22 files |
| Phase 01-foundation P04 | 4min | 2 tasks | 2 files |
| Phase 01-foundation P03 | 4min | 2 tasks | 12 files |
| Phase 01-foundation P05 | 4min | 2 tasks | 8 files |
| Phase 01-foundation P06 | ~5min 30s | 2 tasks | 14 files |
| Phase 01-foundation P08 | ~2min | 1 tasks | 3 files |
| Phase 01-foundation P09 | 3min | 2 tasks | 7 files |
| Phase 01-foundation P07 | ~6min | 2 tasks | 11 files |
| Phase 02-ingest-secrets-and-audit P01 | 5min | 2 tasks | 15 files |
| Phase 02-ingest-secrets-and-audit P02 | 7min | 2 tasks | 9 files |
| Phase 02-ingest-secrets-and-audit P03 | 8min 30s | 2 tasks | 18 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap creation: 6 phases derived from architecture tiers (not imposed); standard granularity, all 54 v1 REQ-IDs covered
- Phase 1 includes DEPLOY-05 (self-host CI smoke test) as a gate from day one — prevents parity rot per PITFALLS.md
- Phase 3 begins with two spikes: Reddit `/about/rules` JSON schema (MEDIUM confidence) and `videos.list` batched quota math (50× saving) — both gate downstream design
- [Phase 01-foundation]: Plan 01-01 pinned the Phase 1 locked stack exactly per RESEARCH.md drift table (@hono/node-server@1.19.14 NOT 2.x; pg-boss@10.1.10 NOT 12.x; better-auth@1.6.9; drizzle-orm@0.45.2; hono@4.12.15; paraglide-js@2.16.1)
- [Phase 01-foundation]: src/lib/server/config/env.ts is the SOLE process.env reader; ESLint no-restricted-properties enforces the boundary (P2 mitigation). KEK is decoded, length-checked at 32 bytes, and deleted from process.env after consumption
- [Phase 01-foundation]: Pino redact paths fixed once at logger init covering all 14 D-24 secret-shaped key paths (apiKey, refreshToken, accessToken, password, secret, encrypted_*, wrapped_dek, dek, kek, plus Authorization and Cookie headers)
- [Phase 01-foundation]: Plan 01-02: Wave 0 test scaffolding lands all 12 test files with named-plan it.skip placeholders (Nyquist invariant); vitest 4 test.projects splits unit/integration
- [Phase 01-foundation]: Plan 01-02: Dockerfile = node:22-alpine multi-stage (deps/build/runtime) with non-root UID 10001 and HEALTHCHECK on /readyz; ENTRYPOINT [node, build/server.js] dispatches APP_ROLE (Plan 06 lands runtime dispatch)
- [Phase 01-foundation]: Plan 01-02: CI workflow has SaaS-leak grep step (D-14) - fails PR on hardcoded admin@neotolis or analytics.neotolis or CF-Connecting-IP outside trusted-proxy module
- [Phase 01-foundation]: Plan 01-04: Envelope encryption module — AES-256-GCM via node:crypto, per-row 32-byte DEK wrapped by KEK from env.KEK_VERSIONS Map (per-call loadKek, no module-level cache per AP-6); rotateDek re-wraps DEK only with secretCt byte-identical (D-10 cheap online rotation); 11 vitest cases cover round-trip, 4-field tamper detection, missing-KEK fail-fast, and rotation
- [Phase 01-foundation]: Plan 01-03: Drizzle pg client with APP_ROLE-sized pool (app=10/worker=4/scheduler=2); pg-boss runs on its own pool to avoid contention
- [Phase 01-foundation]: Plan 01-03: advisory-locked runMigrations() with key 0x4D49475241544531 = 5_494_251_782_888_259_377 (BIGINT-safe); migrationsApplied flag exposed for /readyz (Open Question Q4)
- [Phase 01-foundation]: Plan 01-03: Better Auth canonical schema hand-authored against v1.6 default; Plan 05 will run @better-auth/cli generate --diff to verify; all PKs are TEXT with UUIDv7 default-fn (D-06)
- [Phase 01-foundation]: Plan 01-03: audit_log INSERT-only with tenant-relative (user_id, created_at) cursor index — PITFALL P19 cannot fire because the only efficient lookup is tenant-scoped; writeAudit never throws to caller
- [Phase 01-foundation]: Plan 01-03: queue registry declares 4 poll queues + internal.healthcheck from Phase 1 even though Phase 1 runs no jobs (Open Question Q1); MinimalBoss interface insulates from pg-boss 10.x→12.x type drift
- [Phase 01-foundation]: Plan 01-03 deviation (Rule 1): un-ignored drizzle/meta/ from .gitignore — Drizzle migrator requires _journal.json on disk to discover migrations; without it, runMigrations() is a silent no-op on fresh clones
- [Phase 01-foundation]: Plan 01-05: INFO I2 Path 3 (mock-side iss override to https://accounts.google.com) chosen because Better Auth 1.6.x's google provider has no exposed issuer/discoveryUrl knob; oauth2-mock-server beforeTokenSigning hook coerces iss so test path === prod path on the Better Auth side
- [Phase 01-foundation]: Plan 01-05: P3 (DTO discipline) tripwire enforced via structural grep — dto.ts cannot contain the literal strings googleSub/refreshToken/accessToken anywhere (including comments); future contributors who paste those names back hit the tripwire
- [Phase 01-foundation]: Plan 01-05: D-13 mechanism = oauth2-mock-server confirmed working; seedUserDirectly bypasses Better Auth signin path for DB-level integration tests; full HTTP redirect dance lands in Plan 01-10 smoke test
- [Phase 01-foundation]: Plan 01-06: trusted-proxy middleware (D-19/D-20) implements CVE-2026-27700 mitigation — XFF/CF/XFP headers honored only when socket peer is in TRUSTED_PROXY_CIDR; right-to-left walk drops trusted hops; PT1-PT6 covered in-plan via Hono app.request synthetic-socket override (BLOCKER 3/6 fix, NOT deferred to Plan 07)
- [Phase 01-foundation]: Plan 01-06: SvelteKit-under-Hono via manual catch-all (Pattern 1 ambiguity resolved). Hono owns auth/health/middleware on the outer port; SvelteKit's adapter-node handler is invoked as Node middleware for catch-all; one process / one image / one port; dev-mode falls back to 404 when build/handler.js missing
- [Phase 01-foundation]: Plan 01-06: secureHeaders config (Q5) ships HSTS max-age=63072000+includeSubDomains, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin; CSP intentionally undefined so SvelteKit's adapter owns the page CSP (single source of truth)
- [Phase 01-foundation]: Plan 01-06: worker/scheduler stubs at D-01-locked paths (src/worker/index.ts, src/scheduler/index.ts) print 'worker stub ready' / 'scheduler stub ready' to stdout for Plan 10 smoke-test grep contract; Plan 08 OVERWRITES these files with real pg-boss implementations and switches strings to 'worker ready' / 'scheduler ready'
- [Phase 01-foundation]: Plan 01-06: APP_ROLE dispatcher (Pattern 1) in src/server.ts runs runMigrations() BEFORE any role entrypoint so worker/scheduler containers also fail fast on schema drift; idempotent + advisory-locked per Plan 03; D-22 graceful shutdown drains pg.Pool on SIGTERM with 60s force-exit fallback
- [Phase 01-foundation]: Plan 01-08: pg-boss worker/scheduler entrypoints replace Plan 06 stubs at D-01 paths; createBoss uses connectionString (own pool) + declareAllQueues on every boot; both roles emit dual ready signal (logger.info + console.log) for Plan 10 grep contract; D-22 graceful shutdown via boss.stop({ wait, graceful, timeout: 60_000 }) → pool.end()
- [Phase 01-foundation]: Plan 01-09: project.inlang/settings.json wires baseLocale=en + locales=[en] (D-17) with @inlang/plugin-message-format@4 reading messages/{locale}.json — locale-add is content-only
- [Phase 01-foundation]: Plan 01-09: messages/en.json holds 9 Phase 1 UI strings (D-18 single-file dictionary at repo root); every src/routes/*.svelte uses m.* exclusively, no hard-coded English literals
- [Phase 01-foundation]: Plan 01-09: VALIDATION 19 (locale-add invariant) asserted via explicit keyset toEqual on Object.keys(messages/en.json).sort() — more durable than toMatchSnapshot across renames; integration test greps m.<key>(...) over .svelte files and asserts each key exists in en.json
- [Phase 01-foundation]: Plan 01-07: Pattern 3 enforcement is TWO LAYERS — tenantScope middleware enforces 'must be SOMEONE' (401 anon); service functions enforce 'must be the OWNER' (NotFoundError on cross-tenant). NotFoundError → 404+'not_found' at HTTP boundary; ForbiddenError exists in taxonomy but is RESERVED for Phase 6+ admin endpoints (tenant-owned resources MUST throw NotFoundError, not ForbiddenError)
- [Phase 01-foundation]: Plan 01-07: Anonymous-401 sweep is COMPLEMENT to (not REPLACEMENT for) explicit per-route assertions — MUST_BE_PROTECTED=['/api/me'] toContain guard + protectedRoutes.length>=1 non-empty guard + explicit per-route /api/me 401/200 tests, all three layers shipped (BLOCKER 2 fix). Phase 2 must extend MUST_BE_PROTECTED when adding /api/games etc.
- [Phase 01-foundation]: Plan 01-07: Cross-tenant 404 sentinel via audit_log (Phase 1 has no /api/games yet); double-eq(userId) WHERE clause encodes Pattern 3 by construction. VALIDATION 8/9 (write/delete cross-tenant) explicit it.skip with EXACT W1 annotations 'deferred to Phase 2: no writable/deletable resource in Phase 1' — Phase 2 GAMES-01 turns them on
- [Phase 01-foundation]: Plan 01-07: PITFALL P3 DTO discipline is BEHAVIORAL tripwire at runtime (not just schema-as-types) — tests/unit/dto.test.ts asserts toUserDto STRIPS googleSub/refreshToken/accessToken/idToken/password/emailVerified even when input rows carry them. TypeScript erases at runtime; the projection function is the runtime guard
- [Phase 02-ingest-secrets-and-audit]: Plan 02-01: GAMES-04 split into GAMES-04a (P2: YouTube channels — typed example for social-handle pattern) + GAMES-04b/c/d (Backlog: Telegram/Twitter/Discord, trigger-gated by real user request); avoids speculative 4-channel ship
- [Phase 02-ingest-secrets-and-audit]: Plan 02-01: KEYS-01 (YouTube key) + KEYS-02 (Reddit OAuth) + INGEST-01 (Reddit URL) deferred Phase 2 → Phase 3; each secret/ingest path lands alongside its consuming poll adapter (poll.youtube / poll.reddit) so no orphan UI ships
- [Phase 02-ingest-secrets-and-audit]: Plan 02-01: AGENTS.md gained ## Privacy & multi-tenancy section (8 invariants + 6 P0-block anti-patterns) as the load-bearing contract downstream planners/executors/checkers cite by invariant number (D-36 / DV-6)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-02: TENANT_TABLES = 8 Phase-2 tables (games, gameSteamListings, youtubeChannels, gameYoutubeChannels, apiKeysSteam, trackedYoutubeVideos, events, auditLog); ALLOWLIST = 4 Better Auth tables (user/session/account/verification) + Phase-5 subredditRules; Phase 3 will classify any new worker-internal tables it lands
- [Phase 02-ingest-secrets-and-audit]: Plan 02-02: RuleTester import path = @typescript-eslint/utils/ts-eslint (deprecated transitive re-export, plan-authorised fallback) — the standalone @typescript-eslint/rule-tester package is not in the dep graph. Wrapped class IS ESLint 9's own RuleTester via inheritance, so flat-config languageOptions.parser works as intended
- [Phase 02-ingest-secrets-and-audit]: Plan 02-02 deviation (Rule 1): single-loop chain walker (over MemberExpression / CallExpression / AwaitExpression) replaces two-loop walk that exited too early on tx.update(<T>).set({...}).where(...). Without the fix the rule was a vacuous-pass on the update form. RuleTester case 3 caught it before any Phase 2 service shipped
- [Phase 02-ingest-secrets-and-audit]: Plan 02-02: tenant-scope rule severity = error (not warn) for src/lib/server/services/**; disable comments require -- justification per AGENTS.md Pitfall 7. Two-layer Pattern 1 enforcement: this rule (STRUCTURAL, lint-time) + tests/integration/tenant-scope.test.ts (BEHAVIORAL, runtime — assertions land in plan 02-08)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-03: audit_action enum source-of-truth lives in src/lib/server/audit/actions.ts but audit-log.ts re-exports it so drizzle-kit's schema scan (./src/lib/server/db/schema/*.ts glob) picks up the CREATE TYPE — without the re-export the enum was silently dropped from the generated SQL (#5174 manifestation)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-03: drizzle-kit 0.31 emitted ALTER COLUMN action TYPE audit_action USING action::audit_action automatically — RESEARCH.md Open Question 2 worst case (manual hand-edit) did not materialize on our pinned drizzle-kit version
- [Phase 02-ingest-secrets-and-audit]: Plan 02-03: AuditEntry.action narrowed from string to AuditAction (Rule 1 fix) so a stray free-form string fails at TypeScript check, not at INSERT — completes the D-32 single-source-of-truth chain at compile-time
- [Phase 02-ingest-secrets-and-audit]: Plan 02-03: partial index on tracked_youtube_videos.last_polled_at WHERE NOT NULL deferred to Phase 3 (Option B from W-4) — column is NULL on every P2 row (no polling worker yet); index would be bloat over an all-NULL column. Filed as ROADMAP Phase 3 deferred item

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 3 spike: confirm Reddit `/about/rules.json` returns raw rules only (not structured cooldown/flair fields) before locking `subreddit_rules` table — gates Phase 5
- Phase 3 spike: confirm batched `videos.list` quota math against live YouTube Data API v3 before committing the worker design
- Phase 4: monitor LayerChart 2.x Svelte 5 beta stability at phase start; ECharts fallback documented and ready

## Session Continuity

Last session: 2026-04-27T20:32:41.758Z
Last Activity: 2026-04-27
Stopped at: Completed 02-03-schema-and-migration-PLAN.md
Resume file: None

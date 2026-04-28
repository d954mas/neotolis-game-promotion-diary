---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Ready to execute
stopped_at: Completed 02-10-svelte-pages-PLAN.md
last_updated: "2026-04-27T22:21:17.127Z"
last_activity: 2026-04-27
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 21
  completed_plans: 20
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Replace messy Google Sheets / markdown files with a structured, secure, query-friendly diary so an indie developer can see — at a glance — which promotion actions actually moved the needle on wishlists and engagement.
**Current focus:** Phase 02 — ingest-secrets-and-audit

## Current Position

Phase: 02 (ingest-secrets-and-audit) — EXECUTING
Plan: 11 of 11

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
| Phase 02-ingest-secrets-and-audit P04 | 7min 38s | 2 tasks | 7 files |
| Phase 02-ingest-secrets-and-audit P05 | 5m 33s | 2 tasks | 6 files |
| Phase 02-ingest-secrets-and-audit P06 | 8m 48s | 3 tasks | 11 files |
| Phase 02-ingest-secrets-and-audit P07 | 5m 7s | 2 tasks | 6 files |
| Phase 02-ingest-secrets-and-audit P08 | 6m 41s | 2 tasks | 14 files |
| Phase 02-ingest-secrets-and-audit P09 | 17m 55s | 3 tasks | 29 files |
| Phase 02-ingest-secrets-and-audit P10 | 19m 50s | 2 tasks | 18 files |

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
- [Phase 02-ingest-secrets-and-audit]: Plan 02-04: soft-cascade tx pattern (D-23) lands as reference impl — captured Date applied to parent + 4 children (game_steam_listings, game_youtube_channels, tracked_youtube_videos, events) in one tx; restore reverses ONLY children whose deletedAt === parent.deletedAt; youtube_channels + api_keys_steam intentionally NOT cascaded (D-24)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-04: comingSoon column carries three states ('true'/'false'/'unavailable') — 'unavailable' is set when fetchSteamAppDetails returns null (Steam down or success:false); Phase 6 backfill worker recognizes rows by this sentinel
- [Phase 02-ingest-secrets-and-audit]: Plan 02-04: fetchSteamAppDetails wraps full fetch in try/catch (deviation Rule 1 from RESEARCH.md verbatim shape which had try/finally only) — addSteamListing always succeeds on Steam-down; AbortError no longer bubbles out as 500
- [Phase 02-ingest-secrets-and-audit]: Plan 02-04: softDeleteGame + updateGame + removeSteamListing add isNull(deletedAt) to WHERE so a second call on already-deleted row throws NotFoundError (idempotency made explicit; Plan 02-08 routes expect 404 on double-delete) — minor refinement to RESEARCH.md soft-cascade pattern
- [Phase 02-ingest-secrets-and-audit]: Plan 02-04: Phase 1 deferred VALIDATION 9 (cross-tenant DELETE 404) closed at the service layer in games.test.ts — softDeleteGame(userB.id, aGame.id) throws NotFoundError; Plan 02-08 will additionally cover the HTTP boundary
- [Phase 02-ingest-secrets-and-audit]: Plan 02-05: probeSteamKey private helper centralizes 4xx→422 / 5xx→502 mapping; both createSteamKey and rotateSteamKey call it so error semantics stay consistent and a future audit/retry refinement happens in one location
- [Phase 02-ingest-secrets-and-audit]: Plan 02-05: rotateSteamKey calls getSteamKeyById BEFORE the Steam probe (Rule 2 fix) — cross-tenant rotation attempts throw NotFoundError without ever calling Steam, closing existence-leak side-channel via response timing and saving Valve quota
- [Phase 02-ingest-secrets-and-audit]: Plan 02-05: removeSteamKey audits BEFORE the DELETE (D-32 forensics) — even if DELETE fails the security signal is captured. Reverse order would let a transient DB error swallow the audit row
- [Phase 02-ingest-secrets-and-audit]: Plan 02-05: decryptSteamKeyForOperator exported but documented internal-only — Phase 2 only uses it in tests (envelope round-trip proof); Phase 3 worker is the only future production caller. The 'forOperator' suffix is the reviewer signal that any PR adding a Hono route fails review under D-39
- [Phase 02-ingest-secrets-and-audit]: Plan 02-05: toApiKeySteamDto behavioural test in tests/unit/dto.test.ts is the runtime guard for D-39 — TypeScript erases at runtime; the projection function is the only barrier. Test asserts strip happens against a row literal carrying every ciphertext column
- [Phase 02-ingest-secrets-and-audit]: Plan 02-06: AppError extended with optional 4th metadata arg — youtube_unavailable carries {reason:'private'|'unavailable'} so Plan 02-08 can map a single 422 code to two distinct Paraglide messages without parsing message strings (Rule 2 fix; backward-compatible — NotFoundError still passes 3 args)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-06: youtube-oembed integration ships W-6 discriminated-union return (kind: ok|unavailable|private) instead of RESEARCH.md §6's null contract — single null couldn't distinguish private vs deleted vs 5xx. Three kinds + thrown-on-5xx maps each axis to a distinct AppError code/metadata combination Plan 02-08 consumes mechanically
- [Phase 02-ingest-secrets-and-audit]: Plan 02-06: items-youtube.createTrackedYoutubeVideo wraps INSERT in try/catch ONLY to translate Postgres unique_violation 23505 → AppError 'duplicate_item' 409 — the EXCEPTION to the no-try/catch-around-insert D-19 rule (mapping a known DB constraint to a clean HTTP code is not cleaning up a half-write). The half-write rule still holds: no INSERT-then-DELETE-on-error path exists
- [Phase 02-ingest-secrets-and-audit]: Plan 02-06: listTimelineForGame uses tracked_youtube_videos.addedAt as the timeline timestamp (no occurredAt column on tracked videos). Two indexed selects + JS Array.sort beats a UNION ALL with disparate column shapes; matches the indie-budget zero-paid-DB-feature constraint
- [Phase 02-ingest-secrets-and-audit]: Plan 02-07: PITFALL P19 mitigated by query construction (userId WHERE clause FIRST in and(...) and INDEPENDENT of cursor) — opacity is incidental, not the security property; cross-tenant integration test is the runtime assertion
- [Phase 02-ingest-secrets-and-audit]: Plan 02-07: cursor format = base64url(JSON.stringify({at: ISO, id})); tuple-comparison (created_at, id) < (, ) is order-stable under same-ms ties because UUIDv7 ids are strictly monotonic — no SUBSELECT needed for cross-page disjointness
- [Phase 02-ingest-secrets-and-audit]: Plan 02-07: defense-in-depth on actionFilter — assertValidActionFilter validates against AUDIT_ACTIONS const before SQL builder; Plan 02-08 zod is the second guard. Two layers because a future smoke/forensic call can land in audit-read.ts without going through Hono
- [Phase 02-ingest-secrets-and-audit]: Plan 02-07: unit tests seed env via process.env.X ??= before await import(...) — established codebase pattern (proxy-trust.test.ts); audit.ts and audit-read.ts both value-import db/client.js which loads env at module init
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: centralized mapErr + RouteVars in routes/_shared.ts (Rule 3 fix) — every Phase 2 route file imports the shared helper; status type widened to Hono's ContentfulStatusCode so AppError carrying any 4xx/5xx (422, 502, 409) flows through without per-route mapping tables
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: AppError code mapping is automatic via mapErr — no per-route translation table; createSteamKey throwing AppError(422 'steam_key_label_exists') flows directly to {error:'steam_key_label_exists'} status 422 — Plan 02-09's Paraglide picker keys on the code string with zero message-string parsing at the boundary
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: DELETE /api/youtube-channels/:id INTENTIONALLY NOT shipped — service layer has no removeChannel; user-facing 'remove channel' detaches per-game via DELETE /api/games/:gameId/youtube-channels/:channelId. Future channel-level deletion lands the service function first
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: TimelineRow discriminated union from services/events.ts shipped over the wire from GET /api/games/:gameId/timeline as-is — no toTimelineRowDto needed because the union has no userId field by construction (built from already-projected fields). The lone exception to 'every response through a projection function', justified by P3 by-construction compliance
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: D-37 cross-tenant matrix uses expect.soft for 21 probes — single test surfaces every violation in one run rather than failing on the first; load-bearing for matrix size. Each probe carries a descriptive failure message keyed on method+path so triage doesn't require re-running individual probes
- [Phase 02-ingest-secrets-and-audit]: Plan 02-08: log-redact assertion is coarse (regex against base64-shaped strings after column-name keys) — fast-redact path-by-path fuzzing deferred to Phase 6 polish. Sufficient for the cross-cutting plaintext-and-ciphertext-don't-leak invariant the plan requires
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: themeHandle exported separately from handle (Rule 3 fix) so the SSR-no-flash integration test can call it directly with a synthetic event — production path remains handle = sequence(authHandle, themeHandle); the export is purely additive
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: src/hooks.server.ts uses RELATIVE imports (./lib/auth.js) instead of $lib/* aliases — vitest doesn't load the full sveltekit() plugin so $lib is unresolved at test time; matches established pattern across the test suite
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: vitest.config.ts wires @sveltejs/vite-plugin-svelte (existing dep, no new install) on root + every project so integration tests can import .svelte files for SSR rendering via Svelte 5's built-in render from svelte/server (no @testing-library/svelte added — W-2 honored)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: tests/unit/paraglide.test.ts D-41 keyset snapshot expanded from Phase 1's 9 keys to Phase 2's full 80-key alphabetical snapshot — test INTENT preserved (a future PR adding a key without expanding this list trips the test); locale-add invariant contract upheld
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: eslint.config.js .svelte block now includes the same TS-aware no-unused-vars rule (argsIgnorePattern: ^_) as the .ts block — Svelte 5 component callback prop types like onChange: (v: T) => void no longer false-positive
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: cookie-wins reconciliation NOT wired here — the third theme test stub stays it.skip with annotation '02-10: cookie wins on signin (deferred to Plan 10 +layout.server.ts wire)'; the reconciliation logic belongs in +layout.server.ts which Plan 10 amends
- [Phase 02-ingest-secrets-and-audit]: Plan 02-09: TagChip component INTENTIONALLY NOT shipped — UI-SPEC inventory listed it but tag chips render inline as <span class='chip'> in GameCard; promoting to a standalone abstraction now is premature for one consumer (Phase 4 may earn it when chip interactivity arrives)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-10: RETENTION_DAYS routed via +layout.server.ts (NOT a dedicated GET /api/me/retention route) — preserves env-discipline invariant (src/lib/server/config/env.ts is SOLE env reader); pages consume via await parent(); unit-test grep enforces it
- [Phase 02-ingest-secrets-and-audit]: Plan 02-10: /events ships per-game-fetch + JS merge (not a global GET /api/events) per UI-SPEC; Phase 6 polish adds the single endpoint when math hurts; indie-scale lists make the JS merge fine in P2
- [Phase 02-ingest-secrets-and-audit]: Plan 02-10: Plan 09's third theme test stub (cookie-wins reconciliation) flipped from it.skip → live it() exercising +layout.server.ts directly via synthetic event (not via app.request — SvelteKit handler is build-time-only); asserts both result.theme matches cookie AND DB row was updated
- [Phase 02-ingest-secrets-and-audit]: Plan 02-10: env-discipline grep (tests/unit/logger.test.ts) does not distinguish code from comments — initial Plan 10 comments mentioning literal 'process.env' to explain WHY the value is routed through layout tripped the test; rewrote to 'the Node env' / 'env vars via the Node global' (Rule 3 — blocking — fixes preserve educational intent without weakening the cross-cutting invariant)
- [Phase 02-ingest-secrets-and-audit]: Plan 02-10: /accounts/youtube intentionally omits channel-level remove (consistent with Plan 02-08 not shipping DELETE /api/youtube-channels/:id — service layer has no removeChannel); per-game detach flow (DELETE /api/games/:gameId/youtube-channels/:channelId) shipped on game-detail page covers the user-facing 'remove' need

### Pending Todos

- 2026-04-28-show-user-avatar-and-email-in-ui — AppHeader account disambiguation (caught in Phase 2 manual UAT)

### Blockers/Concerns

- Phase 3 spike: confirm Reddit `/about/rules.json` returns raw rules only (not structured cooldown/flair fields) before locking `subreddit_rules` table — gates Phase 5
- Phase 3 spike: confirm batched `videos.list` quota math against live YouTube Data API v3 before committing the worker design
- Phase 4: monitor LayerChart 2.x Svelte 5 beta stability at phase start; ECharts fallback documented and ready

## Session Continuity

Last session: 2026-04-27T22:21:17.123Z
Last Activity: 2026-04-27
Stopped at: Completed 02-10-svelte-pages-PLAN.md
Resume file: None

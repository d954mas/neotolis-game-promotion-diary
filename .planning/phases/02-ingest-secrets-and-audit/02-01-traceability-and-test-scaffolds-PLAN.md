---
phase: 02-ingest-secrets-and-audit
plan: 01
type: execute
wave: 0
depends_on: []
files_modified:
  - .planning/REQUIREMENTS.md
  - .planning/ROADMAP.md
  - AGENTS.md
  - tests/integration/games.test.ts
  - tests/integration/game-listings.test.ts
  - tests/integration/secrets-steam.test.ts
  - tests/integration/ingest.test.ts
  - tests/integration/events.test.ts
  - tests/integration/audit.test.ts
  - tests/integration/theme.test.ts
  - tests/integration/empty-states.test.ts
  - tests/integration/log-redact.test.ts
  - tests/unit/url-parser.test.ts
  - tests/unit/audit-cursor.test.ts
  - tests/unit/audit-append-only.test.ts
autonomous: true
requirements: []
requirements_addressed: []
must_haves:
  truths:
    - "REQUIREMENTS.md and ROADMAP.md reflect the post-refinement Phase 2 scope (16 distinct REQ-IDs, 18 line-items)"
    - "AGENTS.md carries an explicit Privacy & multi-tenancy block downstream agents can cite"
    - "Every Phase 2 integration / unit test file exists with named-plan it.skip placeholders so later waves can fill them in"
    - "Locale-add invariant remains: messages/en.json shape stays consistent until plan 09 adds keys"
  artifacts:
    - path: ".planning/REQUIREMENTS.md"
      provides: "Updated traceability table; KEYS-01/02/INGEST-01 → Phase 3; GAMES-04 split into GAMES-04a (P2) + GAMES-04b/c/d (backlog)"
      contains: "GAMES-04a"
    - path: ".planning/ROADMAP.md"
      provides: "Phase 2 / Phase 3 success criteria amended; coverage-by-phase row counts updated"
      contains: "Phase 2 — Ingest, Secrets, Audit | 16"
    - path: "AGENTS.md"
      provides: "Privacy & multi-tenancy block (D-36 / DV-6)"
      contains: "## Privacy & multi-tenancy"
    - path: "tests/integration/games.test.ts"
      provides: "GAMES-01 / GAMES-02 placeholder it.skip stubs"
      min_lines: 20
    - path: "tests/integration/secrets-steam.test.ts"
      provides: "KEYS-03..06 placeholder it.skip stubs"
      min_lines: 20
    - path: "tests/integration/ingest.test.ts"
      provides: "INGEST-02..04 + Twitter/Telegram placeholder it.skip stubs"
      min_lines: 20
    - path: "tests/integration/events.test.ts"
      provides: "EVENTS-01..03 placeholder it.skip stubs"
      min_lines: 20
    - path: "tests/integration/audit.test.ts"
      provides: "PRIV-02 + tenant-relative cursor + KEYS-06 metadata placeholder stubs"
      min_lines: 20
    - path: "tests/integration/theme.test.ts"
      provides: "UX-01 placeholder stubs (SSR no-flash, POST, reconcile)"
      min_lines: 15
    - path: "tests/integration/empty-states.test.ts"
      provides: "UX-03 placeholder stubs"
      min_lines: 10
    - path: "tests/integration/log-redact.test.ts"
      provides: "Cross-cutting Pino-redact placeholder stub for new ciphertext field names"
      min_lines: 10
    - path: "tests/unit/url-parser.test.ts"
      provides: "URL canonicalization placeholder stubs"
      min_lines: 10
    - path: "tests/unit/audit-cursor.test.ts"
      provides: "Cursor encode/decode round-trip placeholder stub"
      min_lines: 10
    - path: "tests/unit/audit-append-only.test.ts"
      provides: "writeAudit module exports no update path"
      min_lines: 10
  key_links:
    - from: ".planning/REQUIREMENTS.md"
      to: ".planning/ROADMAP.md"
      via: "Same REQ-IDs in both files match (KEYS-01/02/INGEST-01 marked Phase 3 in BOTH)"
      pattern: "KEYS-01.*Phase 3"
    - from: "tests/integration/*.test.ts"
      to: "src/lib/server/services/* (Wave 1)"
      via: "Tests import services that don't yet exist; placeholders use it.skip with named plans"
      pattern: "it\\.skip\\(['\\\"][^'\\\"]+['\\\"]"
---
<!-- NOTE: This plan rewrites REQUIREMENTS.md and ROADMAP.md per CONTEXT.md D-02/D-03/D-04/D-07.
     After execution, only GAMES-04a/b/c/d codes exist (GAMES-04 deleted); KEYS-01/02 and
     INGEST-01 are deferred to Phase 3. This plan therefore lists no P2 REQ-IDs in its
     frontmatter — its job is the doc move itself, not delivery of any P2 requirement. -->


<objective>
Wave 0 traceability commit + Wave 0 test scaffolding. Land the documentation moves (REQUIREMENTS.md / ROADMAP.md / AGENTS.md) that capture the "example + pattern" scope refinement (D-04 / D-36 / DV-1..8), and create every test file Wave 1+ will fill in. This is the first commit of Phase 2 and prevents drift between docs and code from the very first plan.

Purpose: Make scope refinement load-bearing for downstream agents (REQUIREMENTS.md is the contract; ROADMAP.md is the success-criteria source of truth; AGENTS.md is read by every future planner / executor / checker). Land the Nyquist invariant: every later task ships into a test file that already exists.

Output: Updated docs + 12 new test files (placeholders) committed to git in one atomic commit per Conventional Commits.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@AGENTS.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-VALIDATION.md

<interfaces>
<!-- Phase 1 already established the structural pattern for Wave 0 placeholder tests:
     `it.skip('plan-NN-MM: <behavior>', () => { /* placeholder */ })`. The named-plan
     prefix means each later plan can grep for its own placeholders and fill them in.
     Reference Phase 1 plan 01-02's Wave 0 scaffolding — the same pattern applies here. -->

Existing Phase 1 conventions (do NOT redeclare):

From `tests/setup/db.ts` and `tests/setup.ts`: vitest test.projects splits "unit" / "integration"; integration tests run a Drizzle migrate-up before the suite. Test files under `tests/integration/` automatically join the integration project.

From `tests/integration/helpers.ts`: `seedUserDirectly({ email, name? })` — bypasses Better Auth signin, creates a user row + a session row, returns `{ id, signedSessionCookieValue, ... }`. Use this for any test that needs an authenticated cookie.

From Phase 1 anonymous-401.test.ts: the `MUST_BE_PROTECTED` array is the vacuous-pass guard; new Phase 2 routes get added to that array later (plan 08), not in this plan.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Update REQUIREMENTS.md + ROADMAP.md traceability + AGENTS.md privacy block</name>
  <files>.planning/REQUIREMENTS.md, .planning/ROADMAP.md, AGENTS.md</files>
  <read_first>
    - .planning/REQUIREMENTS.md (current traceability table — see lines 144–211 for the per-REQ rows + coverage-by-phase summary)
    - .planning/ROADMAP.md (Phase 2 entry at lines 47–60; Phase 3 entry at lines 62–77)
    - AGENTS.md (current "Constraints" block — replace the single-line "Privacy: private by default..." with the extended block per D-36 / DV-6)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-04 (full bullet list of edits) and `<deviations>` DV-1..8
  </read_first>
  <action>
    Three file edits in one task — they are docs-only and ship together as one Conventional Commit.

    **A. .planning/REQUIREMENTS.md edits:**
    1. In the GAMES section, change the GAMES-04 line. Replace:
       `- [ ] **GAMES-04**: User can attach multiple associated channels per game — multiple YouTube channels, multiple Telegram channels, multiple Twitter handles, optional Discord — each as a separate row, not a single field`
       with:
       `- [ ] **GAMES-04a**: User can attach multiple YouTube channels per game (typed example for the social-handle pattern; per-channel as a separate row, not a single field)`
       Then append three NEW lines below it:
       `- [ ] **GAMES-04b**: User can attach Telegram channels per game *(by trigger — added when a real user requests Telegram channel tracking; pattern proven by GAMES-04a)*`
       `- [ ] **GAMES-04c**: User can attach Twitter/X handles per game *(by trigger; pattern proven by GAMES-04a)*`
       `- [ ] **GAMES-04d**: User can attach an optional Discord invite per game *(by trigger; pattern proven by GAMES-04a)*`
    2. In the Traceability table (`| REQ-ID | Phase |`):
       - Change `| KEYS-01 | Phase 2 |` → `| KEYS-01 | Phase 3 |`
       - Change `| KEYS-02 | Phase 2 |` → `| KEYS-02 | Phase 3 |`
       - Change `| INGEST-01 | Phase 2 |` → `| INGEST-01 | Phase 3 |`
       - Replace the single `| GAMES-04 | Phase 2 |` row with four rows: `| GAMES-04a | Phase 2 |`, `| GAMES-04b | Backlog |`, `| GAMES-04c | Backlog |`, `| GAMES-04d | Backlog |`
    3. In the "Coverage by Phase" table:
       - Phase 2 row: change `| Phase 2 — Ingest, Secrets, Audit | 21 | GAMES (4), KEYS (6), INGEST (4), EVENTS (3), PRIV (1), UX (3) |` to `| Phase 2 — Ingest, Secrets, Audit | 18 | GAMES (4: GAMES-01..03 + GAMES-04a), KEYS (4: KEYS-03..06), INGEST (3: INGEST-02..04), EVENTS (3), PRIV (1), UX (3) |` *(note: 18 line-items; the 16 distinct REQ-IDs is also reflected in the phase header below)*
       - Phase 3 row: change `| Phase 3 — Polling Pipeline | 9 | POLL (6), WISH (3) |` to `| Phase 3 — Polling Pipeline | 12 | POLL (6), WISH (3), KEYS (2: KEYS-01..02), INGEST (1: INGEST-01) |`
       - Total row: change `| **Total** | **54** | |` to `| **Total** | **54 v1 + 3 backlog** | (backlog: GAMES-04b/c/d) |`

    **B. .planning/ROADMAP.md edits to Phase 2 entry (around lines 47–60):**
    1. Replace the "Requirements:" line content. Current: `**Requirements**: GAMES-01, GAMES-02, GAMES-03, GAMES-04, KEYS-01, KEYS-02, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-01, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01, UX-02, UX-03`
       New: `**Requirements**: GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01, UX-02, UX-03 *(KEYS-01, KEYS-02, INGEST-01 moved to Phase 3 per CONTEXT.md DV-1/DV-7; GAMES-04 split into GAMES-04a (P2) + GAMES-04b/c/d (backlog) per DV-8)*`
    2. Amend success criterion #1 (the "creates a game card" one). Replace `can attach multiple YouTube channels, Telegram channels, Twitter handles, and an optional Discord per game` with `can attach multiple YouTube channels per game (Telegram channels, Twitter handles, and optional Discord deferred to backlog by trigger per CONTEXT.md DV-8)`.
    3. Amend success criterion #2 (the "Reddit post URL or YouTube video URL" one). Replace `User pastes a Reddit post URL or a YouTube video URL on a game and a tracked item is created (with own/blogger flag for YouTube videos, toggleable later)` with `User pastes a YouTube video URL on a game and a tracked item is created (with own/blogger flag, toggleable later); user pastes a Twitter or Telegram URL and a free-form events row is created; user pastes a Reddit URL and sees an inline "Reddit support arrives in Phase 3" message (Reddit ingest moves to Phase 3 alongside poll.reddit per CONTEXT.md DV-7)`.
    4. Amend success criterion #3 (the "saves a YouTube API key" one). Replace `User saves a YouTube API key, authorizes Reddit OAuth, and optionally saves a Steam Web API key` with `User saves a Steam Web API key (YouTube API key paste UI and Reddit OAuth flow move to Phase 3 alongside their respective poll adapters per CONTEXT.md DV-1)`.

    **C. .planning/ROADMAP.md edits to Phase 3 entry (around lines 62–77):**
    1. Replace `**Requirements**: POLL-01, POLL-02, POLL-03, POLL-04, POLL-05, POLL-06, WISH-01, WISH-02, WISH-03` with `**Requirements**: POLL-01, POLL-02, POLL-03, POLL-04, POLL-05, POLL-06, WISH-01, WISH-02, WISH-03, KEYS-01, KEYS-02, INGEST-01 *(KEYS-01, KEYS-02, INGEST-01 deferred from Phase 2 per CONTEXT.md DV-1/DV-7 — land alongside their respective poll adapters)*`.
    2. Append two NEW success-criterion bullets to Phase 3 (numbered 8 and 9, before the Phase 3 smoke extension bullet):
       - `8. *(Deferred from Phase 2)* User saves a YouTube Data API v3 key (envelope-encrypted at rest); the key is consumed by `poll.youtube` worker. User authorizes Reddit via OAuth (per-user, BYO Reddit app credentials) and rotates / revokes at any time; the credentials are consumed by `poll.reddit` worker.`
       - `9. *(Deferred from Phase 2)* User pastes a Reddit post URL on a game and a tracked Reddit post is created; ingest validates against Reddit API; on success the row enters the polling pipeline alongside YouTube videos.`

    **D. AGENTS.md edits — add a new top-level section after the existing "## Constraints" section.** Insert this new section:

    ```markdown
    ## Privacy & multi-tenancy

    These rules are non-negotiable. Every endpoint, query, service, and DTO honors them. Drift is treated as a P0 review block.

    1. **Tenant scoping is mandatory and explicit.** Every service function takes `userId: string` as the first non-optional argument. Every Drizzle query against a user-owned table includes `eq(<table>.userId, userId)` in `.where(...)`. The `eslint-plugin-tenant-scope/no-unfiltered-tenant-query` rule (Phase 2 Wave 0) catches missing filters at lint time; the cross-tenant integration test (`tests/integration/tenant-scope.test.ts`) catches behavioral drift at CI time.
    2. **Cross-tenant access returns 404, never 403.** When a service fetches a tenant-owned row scoped by `userId` and the row is missing OR owned by another user, it MUST throw `NotFoundError` from `src/lib/server/services/errors.ts`. The HTTP boundary translates to `{error: 'not_found'}` with status 404. The response body MUST NOT contain the literal strings "forbidden" or "permission" for tenant-owned resources. `ForbiddenError` is reserved for Phase 6+ admin endpoints only.
    3. **Anonymous-401 sweep covers every `/api/*` route.** Every new authenticated route is added to the `MUST_BE_PROTECTED` allowlist in `tests/integration/anonymous-401.test.ts`. The sweep is the vacuous-pass guard; per-route assertions are the explicit assertions. Both layers are required.
    4. **Audit log is INSERT-only and tenant-relative.** `src/lib/server/audit.ts` exports `writeAudit` only — there is no update / delete path. Pagination uses `(user_id, created_at desc)` cursor; cursors never observe another tenant's row IDs by construction (PITFALL P19). The application database role MUST NOT have UPDATE / DELETE grants on `audit_log`.
    5. **DTO discipline strips secrets at the projection layer.** Every entity has a `to<Entity>Dto` projection function in `src/lib/server/dto.ts`. Ciphertext columns (`secret_ct`, `secret_iv`, `secret_tag`, `wrapped_dek`, `dek_iv`, `dek_tag`, `kek_version`) are stripped at projection time, even when the underlying row carries them. TypeScript erases at runtime; the projection function is the actual barrier. Behavioral test in `tests/unit/dto.test.ts` asserts the strip happens at runtime, not just at type-check time.
    6. **Pino redact paths cover every credential / ciphertext field name.** `src/lib/server/logger.ts` redacts `apiKey`, `accessToken`, `refreshToken`, `idToken`, `secret`, `encrypted_*`, `wrapped_dek`, `dek`, `kek`, `Authorization`, `Cookie`. Phase 2 introduces no new secret-shaped field names; if you need a new one, add the redact path in the same commit.
    7. **No public dashboards, share links, or read-only viewers.** No route lives under `/share`, `/public`, or `/embed`. Every page that renders user data is auth-gated.
    8. **Self-host parity is identical to SaaS behavior.** No code path branches on `APP_MODE`; the smoke test (`.github/workflows/ci.yml smoke job`) boots the production image with no SaaS-only env vars and refuses to merge if anything depends on a managed service or hard-coded admin allowlist.

    Anti-patterns that are P0 review blocks:
    - `db.select().from(<tenant_table>).where(eq(<table>.id, ...))` without `userId` filter.
    - `c.json(<row>)` after fetching a row that contains ciphertext columns.
    - In-process plaintext-secret cache (anti-pattern AP-3 in `.planning/research/ARCHITECTURE.md`).
    - `403 Forbidden` for cross-tenant access on tenant-owned resources (use 404).
    - `try/catch` after `db.insert(...)` that "cleans up" a half-write (validate-first; INSERT only after pass).
    - Reading `process.env` outside `src/lib/server/config/env.ts` (ESLint `no-restricted-properties` enforces).
    ```
  </action>
  <verify>
    <automated>node -e "const fs=require('fs');const r=fs.readFileSync('.planning/REQUIREMENTS.md','utf8');const ro=fs.readFileSync('.planning/ROADMAP.md','utf8');const a=fs.readFileSync('AGENTS.md','utf8');if(!/GAMES-04a/.test(r))throw 'REQ.md missing GAMES-04a';if(!/\\| KEYS-01 \\| Phase 3 \\|/.test(r))throw 'REQ.md KEYS-01 not moved';if(!/\\| INGEST-01 \\| Phase 3 \\|/.test(r))throw 'REQ.md INGEST-01 not moved';if(!/Phase 2.*\\| 18 \\|/.test(r))throw 'REQ.md coverage row not 18';if(!/GAMES-04a/.test(ro))throw 'ROADMAP missing GAMES-04a';if(!/Reddit support arrives in Phase 3/.test(ro))throw 'ROADMAP Phase 2 SC#2 not amended';if(!/## Privacy \\& multi-tenancy/.test(a))throw 'AGENTS.md missing Privacy section';if(!/Cross-tenant access returns 404, never 403/.test(a))throw 'AGENTS.md missing 404-not-403 rule';console.log('ok')"</automated>
  </verify>
  <done>
    REQUIREMENTS.md, ROADMAP.md, and AGENTS.md all reflect the post-refinement scope:
    - REQUIREMENTS.md has GAMES-04a/b/c/d split, KEYS-01/02/INGEST-01 marked Phase 3, coverage rows reflect 18 P2 / 12 P3 line-items.
    - ROADMAP.md Phase 2 success criteria #1, #2, #3 amended; Phase 3 success criteria gain bullets 8 and 9.
    - AGENTS.md has a dedicated `## Privacy & multi-tenancy` section after the Constraints block, citing the 8 invariants and the P0-block anti-patterns list.
    The grep-based verify command passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wave 0 placeholder test files (12 new files, named-plan it.skip stubs)</name>
  <files>tests/integration/games.test.ts, tests/integration/game-listings.test.ts, tests/integration/secrets-steam.test.ts, tests/integration/ingest.test.ts, tests/integration/events.test.ts, tests/integration/audit.test.ts, tests/integration/theme.test.ts, tests/integration/empty-states.test.ts, tests/integration/log-redact.test.ts, tests/unit/url-parser.test.ts, tests/unit/audit-cursor.test.ts, tests/unit/audit-append-only.test.ts</files>
  <read_first>
    - tests/integration/tenant-scope.test.ts (Phase 1 placeholder pattern; lines 53–60 are the existing it.skip stubs with named-plan annotations — this is the pattern every new file replicates)
    - tests/integration/anonymous-401.test.ts (vacuous-pass `MUST_BE_PROTECTED` guard pattern — Wave 0 does NOT extend this; plan 08 does)
    - tests/setup.ts and tests/setup/db.ts (test bootstrap — confirms test.projects split unit vs integration so file location alone selects the project)
    - tests/integration/helpers.ts (seedUserDirectly export shape used by integration stubs)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Validation Architecture" → "Phase Requirements → Test Map" (the named-test list with "Wave 0" markers — the placeholder names below come from this table)
  </read_first>
  <behavior>
    Each test file ships as a placeholder containing one `describe(...)` and one or more `it.skip(...)` calls with the EXACT plan-NN-MM annotation per the Validation Architecture matrix. it.skip body is a no-op comment. Vitest reports each as "skipped" until the implementing plan flips it to `it(...)`.

    Behavior contract per file:
    - games.test.ts: 4 it.skip stubs — `02-04: GAMES-01 create game returns 201 + DTO`, `02-04: GAMES-01 422 on missing title`, `02-04: GAMES-02 soft cascade delete`, `02-04: GAMES-02 transactional restore`.
    - game-listings.test.ts: 2 it.skip stubs — `02-04: GAMES-04a attach youtube channel`, `02-04: GAMES-04a multiple channels per game (M:N)`.
    - secrets-steam.test.ts: 5 it.skip stubs — `02-05: KEYS-03 envelope encrypted at rest`, `02-05: KEYS-04 DTO strips ciphertext`, `02-05: KEYS-05 rotate overwrites ciphertext + audits`, `02-05: KEYS-05 rotate fails on invalid key (422)`, `02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}`.
    - ingest.test.ts: 8 it.skip stubs — `02-06: INGEST-02 youtube paste creates tracked item with title`, `02-06: INGEST-03 is_own auto decision via youtube_channels match`, `02-06: INGEST-03 toggle is_own`, `02-06: INGEST-04 malformed URL rejects + no half-write`, `02-06: INGEST-04 oembed 5xx no row`, `02-06: INGEST-04 oembed 404 unavailable no row` (W-6 — 422 youtube_unavailable case), `02-06: twitter paste creates events row kind=twitter_post`, `02-06: reddit paste returns inline info, no row created`.
    - events.test.ts: 4 it.skip stubs — `02-06: EVENTS-01 create conference event`, `02-06: EVENTS-01 invalid kind returns 422`, `02-06: EVENTS-02 timeline returns events + items chronological`, `02-06: EVENTS-03 audit on edit and delete`.
    - audit.test.ts: 4 it.skip stubs — `02-07: PRIV-02 page size 50 + cursor`, `02-07: PRIV-02 action filter`, `02-07: PRIV-02 tenant-relative cursor (cross-tenant rejection)`, `02-05: KEYS-06 ip resolved via proxy-trust`.
    - theme.test.ts: 3 it.skip stubs — `02-09: UX-01 SSR no flash (locals.theme set before handler)`, `02-09: UX-01 POST /api/me/theme updates cookie + DB + audits theme.changed`, `02-09: UX-01 cookie wins on signin reconciliation`.
    - empty-states.test.ts: 2 it.skip stubs — `02-09: UX-03 empty /games shows monospace example URL`, `02-09: UX-03 all P2 keys present in messages/en.json`.
    - log-redact.test.ts: 1 it.skip stub — `02-08: cross-cutting Pino redact — ciphertext field names never logged during request flow`.
    - unit/url-parser.test.ts: 5 it.skip stubs — `02-06: parseIngestUrl handles youtube.com/watch?v=ID`, `02-06: parseIngestUrl handles youtu.be/ID`, `02-06: parseIngestUrl handles /shorts/ID and /live/ID`, `02-06: parseIngestUrl canonicalizes x.com → twitter.com`, `02-06: parseIngestUrl returns reddit_deferred for reddit.com`.
    - unit/audit-cursor.test.ts: 2 it.skip stubs — `02-07: encodeCursor + decodeCursor round-trip`, `02-07: cursor decode rejects malformed input`.
    - unit/audit-append-only.test.ts: 2 it.skip stubs — `02-08: writeAudit module exports no update path`, `02-08: writeAudit module exports no delete path`.
  </behavior>
  <action>
    Create 12 files with this template. Each file imports vitest's `describe, it` and uses the EXACT it.skip annotations from the Behavior block above. NO bodies — the body is a single line comment `/* placeholder — implementing plan: 02-NN */`.

    File template (apply per-file with the relevant describe label and it.skip stubs):

    ```typescript
    import { describe, it } from "vitest";

    /**
     * Wave 0 placeholder test file (Plan 02-01 — Phase 2 Wave 0).
     *
     * Per Phase 1 Wave 0 invariant: every later task ships into a test that
     * already exists. The it.skip stubs below are EXACT names — implementing
     * plans (02-NN) replace `it.skip` with `it` and add the assertions.
     *
     * If you are an executor on a later plan and the test you need is NOT in
     * the it.skip list below, the gap is in this Wave 0 plan — fix it here,
     * NOT by silently adding a new it() in your plan's commit.
     */
    describe("<entity / behavior describe label>", () => {
      it.skip("<exact stub annotation from Behavior block>", () => {
        /* placeholder — implementing plan: 02-NN */
      });
      // ... one it.skip line per stub from the Behavior block ...
    });
    ```

    Each file's describe label:
    - games.test.ts: `"games CRUD (GAMES-01, GAMES-02)"`
    - game-listings.test.ts: `"game ↔ youtube-channels link (GAMES-04a)"`
    - secrets-steam.test.ts: `"api_keys_steam envelope encryption (KEYS-03..06)"`
    - ingest.test.ts: `"URL ingest paste-box (INGEST-02..04, twitter/telegram event create)"`
    - events.test.ts: `"events CRUD (EVENTS-01..03)"`
    - audit.test.ts: `"audit log read endpoint (PRIV-02 + KEYS-06 metadata)"`
    - theme.test.ts: `"theme cookie + DB persist (UX-01)"`
    - empty-states.test.ts: `"empty-state copy + Paraglide invariant (UX-03)"`
    - log-redact.test.ts: `"cross-cutting Pino redact (P3 + D-24)"`
    - unit/url-parser.test.ts: `"URL parser canonicalization"`
    - unit/audit-cursor.test.ts: `"audit cursor encode/decode"`
    - unit/audit-append-only.test.ts: `"audit module export shape (P19)"`

    Do NOT import any source files (services, schemas) yet — none exist. The files compile and run cleanly because vitest's it.skip never executes the body.
  </action>
  <verify>
    <automated>pnpm exec vitest run tests/integration/games.test.ts tests/integration/game-listings.test.ts tests/integration/secrets-steam.test.ts tests/integration/ingest.test.ts tests/integration/events.test.ts tests/integration/audit.test.ts tests/integration/theme.test.ts tests/integration/empty-states.test.ts tests/integration/log-redact.test.ts tests/unit/url-parser.test.ts tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|skipped|todo)" | head -60</automated>
  </verify>
  <done>
    All 12 placeholder test files exist; vitest reports each `it.skip` as "skipped" (NOT "failed", NOT "missing test"); no test executes its body; no source-file imports; total skipped count >= 42 across the new files (sum of stub counts in the Behavior block: 4+2+5+8+4+4+3+2+1+5+2+2 = 42; W-6 added one ingest stub).
  </done>
</task>

</tasks>

<verification>
- `git diff --stat .planning/REQUIREMENTS.md .planning/ROADMAP.md AGENTS.md` shows three modified docs.
- `find tests -name '*.test.ts' -newer .planning/STATE.md | wc -l` ≥ 12 (the 12 new placeholder files).
- `pnpm exec vitest run tests/ --reporter=verbose 2>&1 | grep -c "skipped"` ≥ 42 (the placeholder count after W-6 ingest-stub addition).
- `grep -c "GAMES-04a" .planning/REQUIREMENTS.md` ≥ 3.
- `grep -c "## Privacy & multi-tenancy" AGENTS.md` == 1.
</verification>

<success_criteria>
- REQUIREMENTS.md traceability table reflects post-refinement scope (16 distinct P2 REQ-IDs / 18 line-items; KEYS-01/02 + INGEST-01 → Phase 3; GAMES-04a in P2 + GAMES-04b/c/d in backlog).
- ROADMAP.md Phase 2 success criteria #1/#2/#3 amended; Phase 3 success criteria #8 / #9 added; both Requirements: lines updated.
- AGENTS.md carries an explicit `## Privacy & multi-tenancy` section with the 8 invariants and 6 P0-block anti-patterns.
- 12 new placeholder test files exist; vitest can parse and run them (every stub is `it.skip`, no source imports).
- Single Conventional Commit lands all 15 file changes (`docs(02): traceability + Wave 0 test scaffolding`).
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-01-SUMMARY.md` per the template. Highlight: which traceability rows moved, the new AGENTS.md section title, and the count of placeholder it.skip stubs across the 12 files.
</output>

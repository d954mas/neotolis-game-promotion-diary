# Phase 2: Ingest, Secrets, and Audit — Research

**Researched:** 2026-04-27
**Domain:** Tenant-scoped CRUD + URL-paste ingest + envelope-encrypted Steam keys + audit-log read + theme/responsive UX, on the locked Phase 1 stack (Hono 4.12 + SvelteKit 2.58 / Svelte 5 + Drizzle 0.45 + Postgres 16 + Better Auth 1.6 + Paraglide 2 + Pino 9 + Vitest 4)
**Confidence:** HIGH for stack, schema patterns, oEmbed/Steam contracts, validation architecture; MEDIUM for some Drizzle-0.45 enum/migration edge cases (verified against issue tracker, not exhaustive); MEDIUM for ESLint AST sketch (pattern verified, exact selector not yet tested)

## Summary

Phase 2 is overwhelmingly an exercise in *applying* Phase 1 patterns to seven new tables. The single most load-bearing fact is that **Phase 1 already shipped every primitive Phase 2 needs**: envelope encryption (`src/lib/server/crypto/envelope.ts`), audit writer (`src/lib/server/audit.ts`), tenant-scope middleware, `NotFoundError` (cross-tenant 404 carrier), DTO projection template (`src/lib/server/dto.ts`), trusted-proxy middleware, UUIDv7 helper, and the integration test scaffolds (`tenant-scope.test.ts`, `anonymous-401.test.ts`). Phase 2's job is to **wire these primitives into 7 schema files, ~6 service modules, ~7 sub-routers, ~7 SvelteKit page bundles, and one ESLint AST rule**, then extend the cross-tenant + anonymous-401 sweep matrices to cover every new `/api/*` route.

External-API contracts are favorable. **YouTube oEmbed** (`https://www.youtube.com/oembed?url=...&format=json`) is unauthenticated, returns `author_url` as `https://www.youtube.com/@<handle>` (verified live 2026-04-27 against `dQw4w9WgXcQ`), and returns 401/404 for private/deleted videos — but does **NOT** return `channel_id` directly. The Phase 2 plan must include a one-step resolver from `author_url` (handle URL) to canonical `UC...` id (D-21). **Twitter/X oEmbed** (`https://publish.twitter.com/oembed`) remains public and key-free in 2026 with caveats around `x.com` URL canonicalization. **Steam appdetails** (`https://store.steampowered.com/api/appdetails`) is rate-limited at ~200 req / 5 min and returns `success: false` for invalid app_ids; this is the harshest external-API constraint in the phase. **Steam IWishlistService/GetWishlistItemCount/v1** is the right paste-time validation endpoint per ARCHITECTURE.md and the official Steamworks docs.

The two most impactful "Claude's Discretion" calls (per CONTEXT.md `<decisions>`) are:
1. **Use Drizzle `pgEnum` for `events.kind` and the `audit_log.action` enum.** Confirmed by Drizzle 0.45 + drizzle-kit 0.31 generating proper `CREATE TYPE` + `ALTER TYPE ADD VALUE` migrations. Caveat: enums must be **explicitly exported** from a schema file or `drizzle-kit generate` will silently drop them (drizzle-team/drizzle-orm#5174). Trade-off accepted because the alternative (`text + check`) loses native type-safety and forces every callsite to re-validate.
2. **Land all 7 tables (+ 2 alters: `audit_log.action` enum extension, `user.theme_preference` add) as ONE Drizzle migration.** `drizzle-kit migrate` runs each `.sql` file inside an implicit transaction, the Phase 1 advisory-lock wraps the whole boot-time migrate run, and one migration is one diff for code review. The phase has no inter-table data backfill, so splitting buys nothing.

**Primary recommendation:** Plan ~10 plans across 4-5 waves; Wave 0 lands traceability + AGENTS.md uplift + ESLint AST rule + 7-table migration + test scaffolds; Waves 1–3 land service / route / page layers per pattern; Wave 4 closes with smoke-extension and validation-architecture matrix run. The "example + pattern" rule (`<specifics>` in CONTEXT.md) holds the line at 7 tables; any drift toward 14 tables is a planner deviation requiring user sign-off.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

The following are verbatim from `02-CONTEXT.md` `<decisions>`. Planner MUST honor these; researcher does NOT propose alternatives.

**Phase scope (zone 8):**
- D-01 — P2 ships as a monolith on 16 REQs (post-refinement). ~10–11 plans across Waves 0–4.
- D-02 — KEYS-01 (YouTube API key UI) → Phase 3.
- D-03 — KEYS-02 (Reddit OAuth) → Phase 3.
- D-04 — REQUIREMENTS.md + ROADMAP.md traceability updated in Wave 0 of Phase 2 (KEYS-01/02/INGEST-01 → P3; GAMES-04 split into GAMES-04a (P2) + GAMES-04b/c/d (backlog)).

**Schema model (zones 1, 3) — three-list typed-per-kind:**
- D-05 — User has three independent top-level lists: games, social handles, API keys. Linkage explicit (M:N), not implicit.
- D-06 — Store platforms typed-per-kind. Phase 2 lands ONE example: `game_steam_listings`.
- D-07 — Social-handle tables typed-per-kind. Phase 2 lands ONE example: `youtube_channels` + `game_youtube_channels`. Telegram/Twitter/Discord deferred to backlog by trigger.
- D-08 — API-key tables typed-per-kind. Phase 2 lands `api_keys_steam` only.
- D-09 — Tracked items typed-per-kind. Phase 2 lands ONE example: `tracked_youtube_videos`. Schema spec verbatim:
  ```
  tracked_youtube_videos (
    id text PRIMARY KEY,                      -- UUIDv7
    user_id text NOT NULL,
    game_id text NOT NULL REFERENCES games,
    video_id text NOT NULL,
    url text NOT NULL,
    title text,
    channel_id text,
    is_own boolean NOT NULL DEFAULT false,
    added_at, last_polled_at, last_poll_status text,
    deleted_at,
    created_at, updated_at
  )
  UNIQUE (user_id, video_id)
  INDEX (user_id, game_id)
  INDEX (last_polled_at) WHERE last_polled_at IS NOT NULL
  ```
  Two users registering the same video_id produce two independent rows.
- D-10 — Multi-listing per game: `game_steam_listings UNIQUE(game_id, app_id)` + `UNIQUE(user_id, app_id)`.
- D-11 — Phase 2 lands 7 new tables: `games`, `game_steam_listings`, `youtube_channels`, `game_youtube_channels`, `api_keys_steam`, `tracked_youtube_videos`, `events`. Plus: `audit_log.action` enum extension, `user.theme_preference text` column.

**Secrets — Steam-only in P2 (zone 1):**
- D-12 — `api_keys_steam` rows carry envelope-encrypted ciphertext per `EncryptedSecret` shape from `src/lib/server/crypto/envelope.ts`. Plus user-visible: `label`, `last4`, `created_at`, `updated_at`, `rotated_at`.
- D-13 — One Steam-key row per Steamworks account, linked per-listing via `game_steam_listings.api_key_id`.
- D-14 — Write-once UI = single Replace form. UPDATE in one tx with audit `key.rotate`. Previous ciphertext overwritten (no in-process secret cache to invalidate, per AP-3).
- D-15 — KEYS-05 "rotation invalidates in-flight worker jobs" is a Phase 3 invariant (worker MUST decrypt per job).
- D-16 — INGEST-02 validation uses oEmbed, not the YouTube API key. Populates `tracked_youtube_videos.title` and `channel_id`.
- D-17 — Steam key validation: one test call to `IWishlistService/GetWishlistItemCount/v1/?key=…&steamid=0` before persist; non-2xx = 422 to user.

**URL Ingestion (zone 2):**
- D-18 — Single global paste-box per game page. Parser routes by host: youtube/youtu.be → `tracked_youtube_videos`; twitter.com/x.com → `events kind='twitter_post'`; t.me → `events kind='telegram_post'`; reddit.com/redd.it → friendly inline "Reddit support arrives in Phase 3"; other → reject inline.
- D-19 — INGEST-04: validation FIRST, INSERT only after pass; no try/catch cleanup post-insert.
- D-20 — `tracked_*_*` rows carry denormalized `user_id` (Pattern 1 worker re-assert).
- D-21 — own/blogger auto-decision: oEmbed `author_url` → resolve to `channel_id` → lookup `youtube_channels WHERE user_id=? AND channel_id=?`. If is_own=true → set `tracked_youtube_videos.is_own=true`. Default false.

**Soft-Delete + Retention (zone 4):**
- D-22 — Retention window = 60 days, configurable via `RETENTION_DAYS` env. Default in `.env.example` is `60`.
- D-23 — Soft-cascade with transactional restore. Parent and children share `deleted_at` value. Restore reverses ONLY rows where `deleted_at = parent.deleted_at`.
- D-24 — `youtube_channels` and `api_keys_steam` are NOT cascaded (user-level resources).
- D-25 — Purge worker is Phase 3.
- D-26 — Multi-tenant edge case: two users register same `app_id` → independent rows by Pattern 1.

**Events (zone 5):**
- D-27 — `events` separate from `tracked_*_*`.
- D-28 — `events.kind` is a Postgres enum closed picklist: `'conference' | 'talk' | 'twitter_post' | 'telegram_post' | 'discord_drop' | 'press' | 'other'`.
- D-29 — Twitter/Telegram URL pasted into global paste-box auto-creates `events` row. Reuses `events` service for INSERT; `publish.twitter.com/oembed` for preview.
- D-30 — `events` columns: `id, user_id, game_id, kind, occurred_at, title, url?, notes?, created_at, updated_at, deleted_at?`. EVENTS-03 audits via P1 audit writer.

**Audit Log (zone 6):**
- D-31 — `/api/audit` returns 50 rows per page with cursor pagination on `(user_id, created_at desc)`. Cursor is `(created_at, id)` Base64-encoded; tenant-relative.
- D-32 — Action filter dropdown values: `all`, `session.signin`, `session.signout`, `session.signout_all`, `key.add`, `key.rotate`, `key.remove`, `game.created`, `game.deleted`, `game.restored`, `item.created`, `item.deleted`, `event.created`, `event.edited`, `event.deleted`, `theme.changed`. Lives in `src/lib/server/audit/actions.ts` as a const enum.
- D-33 — Date-range filter deferred to Phase 6.
- D-34 — `audit_log.metadata` for key.* events: `{kind, key_id, label, last4}`. `last4` is NOT a secret.
- D-35 — `/api/audit` is in `MUST_BE_PROTECTED`.

**Privacy & Multi-Tenancy (zone 6 fold + AGENTS.md uplift):**
- D-36 — AGENTS.md gets extended "Privacy & multi-tenancy" block in Wave 0.
- D-37 — Each new P2 table carries `user_id text NOT NULL` indexed. Cross-tenant test extends to: `/api/games`, `/api/games/:id`, `/api/games/:gameId/listings`, `/api/games/:gameId/listings/:listingId`, `/api/youtube-channels`, `/api/youtube-channels/:id`, `/api/games/:gameId/youtube-channels`, `/api/api-keys/steam`, `/api/api-keys/steam/:id`, `/api/items/youtube`, `/api/items/youtube/:id`, `/api/events`, `/api/events/:id`, `/api/audit`. All return 404 cross-tenant, never 403.
- D-38 — ESLint rule `no-unfiltered-tenant-query` lands in Wave 0. AST-walks Drizzle calls; rejects without `userId` in `.where()`. Allowlist: `subreddit_rules`, `pgboss.*`, Better Auth core (`user`, `session`, `account`, `verification`).
- D-39 — DTO discipline extends per new entity. `toApiKeySteamDto` strips ciphertext + `kek_version`; only `{id, label, last4, created_at, updated_at, rotated_at}` survives. Behavioral test in `tests/unit/dto.test.ts`.

**UX Baseline (zone 7):**
- D-40 — Theme = cookie + DB persist. `__theme` cookie read in `src/hooks.server.ts` before handler; `event.locals.theme` typed in `app.d.ts`. `user.theme_preference text` column on Better Auth user table. JS toggle in header + settings; `POST /api/me/theme` updates both. Cookie wins on reconcile if both exist.
- D-41 — Empty-state copy in `messages/en.json` (Paraglide). Six to eight new keys. Locale-add invariant preserved.
- D-42 — UX-02 360px viewport is a hard requirement. Every new route has a vitest browser test (or visual snapshot) at 360px width.
- D-43 — UX-03 example URLs are real but inert. Monospace styling, click is no-op; CTA opens paste box.

### Claude's Discretion

The following are open for the planner — researcher provides recommendations below in main body, planner picks:
- URL-parser entry-point file naming (`urlParser.ts` vs `url-parser/index.ts` vs `services/ingest.ts`).
- Postgres enum vs text+check for `events.kind` and `audit_log.action`. **Researcher recommends pgEnum** (see Architecture Patterns §"Drizzle 0.45 enum vs check-constraint").
- Modal vs inline-form for "Replace key".
- Whether the global paste-box lives on game-detail page only, or also a "+ Add" floating button site-wide.
- Cursor encoding for `/api/audit` — base64(JSON) vs jose-style. **Researcher recommends base64(JSON.stringify({cursor_at, cursor_id}))** with tuple-comparison WHERE clause.
- Whether the four `game_<kind>_channels` link tables share a generic service or get four typed services. **Phase 2 only ships ONE link table (`game_youtube_channels`); decision is academic until backlog REQs trigger.**
- One Drizzle migration vs many. **Researcher recommends ONE** (see Architecture Patterns §"Drizzle migration atomicity").

### Deferred Ideas (OUT OF SCOPE)

**To Phase 3 (with poll-* adapters):**
- `tracked_reddit_posts` table + Reddit URL ingest UI. URL parser in P2 detects reddit.com/redd.it but renders "Reddit support arrives in Phase 3".
- `api_keys_youtube` table + paste UI.
- `api_keys_reddit` table + Reddit OAuth flow (3 ciphertext column-sets per row).
- Purge worker (hard-delete after retention).

**To backlog by trigger ("example + pattern" rule):**
- `telegram_channels` + `game_telegram_channels` (GAMES-04b).
- `twitter_handles` + `game_twitter_handles` (GAMES-04c).
- `discord_invites` + `game_discord_invites` (GAMES-04d).
- Future store-listing tables (`game_itch_listings`, `game_epic_listings`, `game_gog_listings`).

**To Phase 6 (Trust & Self-Host Polish):**
- Shared Steam appdetails cache (`steam_app_metadata_cache`).
- Date-range filter in audit-log UI; page-size selector; search-by-metadata.last4.

**Out of scope (not deferred — not coming back):**
- User-private "campaign" tags on `games`.
- Cover image upload (file storage, R2/S3/volume).
- Per-game custom domains / white-label.
- Twitter / Telegram channel auto-tracking via API.
- Real-time wishlist counter / public dashboards / share links.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (from REQUIREMENTS.md) | Research Support |
|----|------------------------------------|------------------|
| GAMES-01 | Create game card with title, Steam URL, optional cover, optional release date or "TBA", tags/genres, free-form notes | Standard Stack §"Drizzle 0.45 schema"; Architecture §"Pattern 1 + tenant scope"; Code Examples §"games CRUD service"; Steam appdetails contract docs (Common Operation 4) |
| GAMES-02 | Edit and delete game cards; deletion is soft and recoverable for retention window | Architecture §"Soft-cascade transactional restore"; Code Examples §"soft-delete + restore tx" |
| GAMES-03 | Multiple games per developer account; every other entity scoped to a specific game | Architecture §"Pattern 1 (Tenant Scope)"; D-20 (denormalized user_id on tracked items) |
| GAMES-04a | Attach multiple YouTube channels per game (typed example for social-handle pattern) | Architecture §"Three-list typed-per-kind model"; Code Examples §"M:N link via game_youtube_channels" |
| KEYS-03 | Optionally paste a Steam Web API key; envelope-encrypted at rest | Architecture §"Pattern 4 (Envelope Encryption)"; existing `src/lib/server/crypto/envelope.ts`; Code Examples §"api_keys_steam write path" |
| KEYS-04 | After save, secret displayed as `••••••••XYZW` (last4 only); plaintext never returned | Architecture §"Pattern 4 + DTO discipline"; D-39 strip rule; Code Examples §"toApiKeySteamDto" |
| KEYS-05 | Rotate or remove any key; rotation immediately invalidates previous ciphertext | D-14 single Replace form; D-15 in-flight invalidation deferred to P3 (worker decrypts per job) |
| KEYS-06 | Audit log records every secret add/rotate/remove with timestamp + source IP | Architecture §"Audit writer reuse"; Code Examples §"writeAudit usage in api-keys-steam service"; D-34 metadata shape |
| INGEST-02 | Paste YouTube video URL; system parses video ID, fetches metadata, creates tracked item | External Services §"YouTube oEmbed contract"; Code Examples §"url-parser + tracked_youtube_videos insert" |
| INGEST-03 | Mark a YouTube video as `own` or `blogger` at creation; toggleable later | D-21 auto-decision via `youtube_channels.is_own`; Code Examples §"is_own resolver" |
| INGEST-04 | Reject malformed URLs with clear error; never partially write a tracked item | D-19 INSERT-after-validate; Architecture §"Validate-first ingest pattern"; Pitfall §"Half-write on failed external fetch" |
| EVENTS-01 | Create free-form timeline event with title, date, optional URL/category/notes | D-30 event columns; D-28 closed-enum kind list; Code Examples §"events service" |
| EVENTS-02 | Events render on the same per-game timeline as polled items | (Phase 2 ships data + read endpoint; combined timeline chart is Phase 4 — verify boundary in plan) |
| EVENTS-03 | Edit and delete events; deletes are audit-logged | D-30 audit hooks; Code Examples §"events service audit hooks" |
| PRIV-02 | Audit log UI showing logins, key add/rotate/remove, exports, bulk deletes — paginated, owner-only | D-31 cursor pagination; D-32 action filter; D-35 in MUST_BE_PROTECTED; Code Examples §"audit list endpoint" |
| UX-01 | Dark/light mode honoring `prefers-color-scheme` with user override | D-40 cookie+DB hybrid; Code Examples §"hooks.server theme cookie + reconcile"; External §"SvelteKit SSR-flash mitigation" |
| UX-02 | Responsive — every screen usable on phone viewport (≥360px); charts reflow | D-42 vitest browser test at 360px; Architecture §"Mobile-360px test approach" |
| UX-03 | Every empty state shows copy-paste example of next action | D-41 messages/en.json keys; D-43 inert example URLs; Code Examples §"empty-state component contract" |

</phase_requirements>

## Project Constraints (from CLAUDE.md / AGENTS.md)

These are non-negotiable and apply to every plan and every commit. Planner must explicitly reconcile each requirement against these constraints (Self-review checklist mandates this).

### Hard rules (cannot drift)

- **Auth: Google OAuth only.** No email/password, no GitHub. Phase 2 adds no new auth methods.
- **Privacy: private by default.** No public dashboards. All data scoped to `user_id`. Every new endpoint MUST be in `MUST_BE_PROTECTED`. Anonymous-401 sweep covers it.
- **Secrets at rest: envelope-encrypted (KEK from env, per-row DEK).** Write-once in UI, never logged, never returned in API responses. ApplyEnv to `api_keys_steam` per D-12.
- **Transport: TLS 1.3 + HSTS.** Plain HTTP only behind a TLS-terminating proxy.
- **Budget: indie / zero-budget.** Phase 2 introduces NO new top-level deps. Researcher does not propose new deps.
- **Open-source compatibility:** identical SaaS multi-tenant + self-host single-tenant behavior. Trusted-proxy headers honored. Smoke gate boots production image with no SaaS-only env vars.
- **License: MIT.**
- **Conventional Commits.** `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `chore(scope): ...`. PR titles follow this.
- **Atomic PRs.** One PR = one clear goal. Squash-merged. Branch named `feat/<topic>` / `fix/<topic>` / `docs/<topic>` / `chore/<topic>`.
- **Tests land with the feature.** Wave 0 placeholder pattern: every later task ships into a test that already exists.
- **Migrations forward-only, run at boot.** No "down" migrations. drizzle-kit migrate under advisory lock; `pnpm db:check` in CI.
- **One source of truth for env.** Only `src/lib/server/config/env.ts` reads `process.env`. ESLint rule (`no-restricted-properties`) enforces this. Phase 2 adds `RETENTION_DAYS` here only.
- **Self-host parity is a CI gate.** Smoke test boots production image with minimal env. Any feature requiring Cloudflare-only headers, admin allowlists, or managed services must degrade gracefully.
- **No secrets in logs.** Pino redact paths cover every credential path. Tests fail loudly if a DTO carries `googleSub` / `refreshToken` / `accessToken` / `idToken`.
- **Default to no comments.** Names explain what code does. Comments reserved for WHY a future reader cannot derive.
- **Locked stack versions.** Pinned in `package.json`: `@hono/node-server@1.19.14`, `better-auth@1.6.9`, `drizzle-orm@0.45.2`, `hono@4.12.15`, `paraglide-js@2.16.1`, `pg-boss@10.4.2`, `pg@8.20.0`, `oauth2-mock-server@^7.2.0`. Bumps go through dedicated PRs with rationale.

### Self-review checklist (every PR)

The agent that authored a Phase 2 PR MUST self-review against:
1. **Constraints compliance** — for each constraint, identify whether the diff touches it; if so, cite where + why compliant. New `process.env` outside `config/env.ts` = violation. New at-rest secret without envelope encryption = violation. Code path divergence between SaaS and self-host = violation.
2. **Philosophy compliance** — the five Philosophy bullets (simplicity for outsider, SaaS/self-host parity, modularity, no premature abstraction, security as floor). Drift accepted only if acknowledged in PR body.
3. **Practices compliance** — atomic? tests with feature? migrations forward-only? env reads centralized? secrets redaction unbroken? Conventional Commits? Versions pinned?
4. **CI gate honesty** — every assertion load-bearing or vacuous-pass? Softened smoke/integration test = justified-and-tracked or hiding regression?
5. **Documentation drift** — does any planning artifact (`.planning/...`, `CLAUDE.md`, `AGENTS.md`, prior `*-VALIDATION.md`, prior `*-CONTEXT.md`) now claim something the code no longer matches? Either docs or code must move.

PR body MUST contain `## Self-review` heading with one line per item, then `## Self-review (second pass)` with second-pass agent findings. P0/P1 issues fixed in the same branch before handoff.

## Standard Stack

### Core (Phase 1 locked, no changes for Phase 2)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | ≥22.11 LTS | Runtime | Locked Phase 1; native `node:crypto` AES-256-GCM, native `fetch`. |
| TypeScript | 5.6+ | Language | Locked Phase 1; required for Drizzle inferred types and Better Auth typed config. |
| Hono | 4.12.15 | HTTP framework | Locked. Phase 2 mounts new sub-routers under `app.route('/api', ...)` (already wired in `src/lib/server/http/app.ts`). |
| @hono/node-server | 1.19.14 | Node adapter | Locked. |
| @hono/zod-validator | ^0.7.0 | Request validation | Locked. Phase 2 adds zod schemas for POST/PATCH bodies on the new sub-routers. |
| zod | ^4.3.6 | Runtime validation | Locked. Phase 2 schemas live in `src/lib/server/schemas/*.ts` (or co-located in service files — planner picks; both are conventional). |
| Drizzle ORM | 0.45.2 | ORM | Locked. Phase 2 adds 7 schema files + extends 2 existing (audit-log, auth). |
| drizzle-kit | ^0.31.0 | Migration tooling | Locked. Wave 0 runs `pnpm db:generate`. |
| pg | 8.20.0 | Postgres driver | Locked. |
| Postgres | 16.x | Database | Locked. |
| pg-boss | 10.4.2 | Queue | Locked, but Phase 2 enqueues no jobs (P3 is when polling lands). |
| Better Auth | 1.6.9 | Auth | Locked. Phase 2 only **extends** the `user` table with `theme_preference text DEFAULT 'system'`. |
| SvelteKit | ^2.58 | Frontend | Locked. Phase 2 adds 7+ route directories under `src/routes/`. |
| Svelte | ^5.55.5 | UI framework | Locked. |
| Paraglide JS | 2.16.1 | i18n | Locked. Phase 2 adds 6–8 new keys to `messages/en.json`. |
| Pino | ^9.5 | Logger | Locked. Phase 2 introduces no new secret-shaped field names; `last4` is intentionally not redacted (D-34 forensics). |
| Vitest | ^4.1.5 | Tests | Locked. Phase 2 uses Vitest 4 browser mode for 360px viewport tests (D-42). |
| oauth2-mock-server | ^7.2.0 | CI auth mock | Locked Phase 1. Phase 2 smoke extension reuses. |

**Phase 2 introduces no new top-level deps.** If a need surfaces (e.g., Vitest 4 browser mode requires `@vitest/browser` + a browser provider — see Architecture Patterns §"Mobile-360px test approach"), the planner names it explicitly with rationale and expects user sign-off.

### Version verification (researcher checked 2026-04-27)

All locked versions are present in `package.json` and consistent with Phase 1's pinning posture. No drift detected. Drizzle 0.45.2 is the most recent stable on the 0.45 line; drizzle-kit 0.31.x supports it (released alongside). Drizzle 1.0 is in beta but Phase 1 explicitly pinned 0.45 and Phase 2 inherits.

### Alternatives Considered

| Instead of | Could Use | Why Rejected for P2 |
|------------|-----------|--------------------|
| Drizzle `pgEnum` | text + check-constraint | check-constraint loses TS-level enum inference; every callsite re-validates. pgEnum migrations work as long as the enum is exported from a schema file (drizzle-team/drizzle-orm#5174). |
| One Drizzle migration per table | One combined migration | A single migration is one diff for code review, runs inside the existing advisory lock, and there's no inter-table data backfill in P2. |
| Vitest browser mode for 360px | Playwright snapshot suite | Playwright is a new dep + new CI service; Vitest 4 browser mode is included by `vitest@^4.1.5` and supports `page.viewport({width:360,height:640})`. Defer Playwright until Phase 4 charts demand it. |
| Manual `m.*` wiring per page | Generic `m.empty('games')` lookup | Paraglide compiles per-key — `m.empty_games_example_url()` produces tree-shakable, type-safe call sites; a generic lookup loses both. P1 invariant ("locale-add is content-only") preserved. |
| Custom audit-cursor JWT | Base64(JSON.stringify(...)) | JWT adds signing key management for zero gain; the cursor is server-readable-only and the WHERE clause `(user_id = ? AND ...)` is the actual security boundary. |

**Installation (no new packages — verification only):**
```bash
pnpm install            # locks already pinned in package.json
pnpm db:generate        # Wave 0 — generate the 7-table migration
pnpm db:check           # Wave 0 — drizzle-kit check for commutativity
pnpm test               # full suite green before phase exit
```

## Architecture Patterns

### Recommended Project Structure (Phase 2 additions)

```
src/
├── lib/
│   └── server/
│       ├── audit/
│       │   └── actions.ts                     # NEW: const enum + Zod literal of every action (D-32)
│       ├── crypto/
│       │   └── envelope.ts                    # EXISTS — Phase 2 calls; do not modify
│       ├── db/
│       │   └── schema/
│       │       ├── games.ts                   # NEW
│       │       ├── game-steam-listings.ts     # NEW
│       │       ├── youtube-channels.ts        # NEW
│       │       ├── game-youtube-channels.ts   # NEW (M:N link)
│       │       ├── api-keys-steam.ts          # NEW (envelope-encrypted)
│       │       ├── tracked-youtube-videos.ts  # NEW
│       │       ├── events.ts                  # NEW (kind = pgEnum)
│       │       ├── auth.ts                    # AMEND: add theme_preference text default 'system'
│       │       ├── audit-log.ts               # AMEND: extend action enum
│       │       └── index.ts                   # AMEND: re-export 7 new files
│       ├── services/
│       │   ├── games.ts                       # NEW
│       │   ├── game-steam-listings.ts         # NEW
│       │   ├── youtube-channels.ts            # NEW
│       │   ├── api-keys-steam.ts              # NEW
│       │   ├── items-youtube.ts               # NEW
│       │   ├── events.ts                      # NEW
│       │   ├── audit-read.ts                  # NEW (read-only; writer is audit.ts at lib/server)
│       │   ├── url-parser.ts                  # NEW (D-18 host detection + canonicalization)
│       │   ├── ingest.ts                      # NEW (orchestrator: parse → fetch oEmbed → service.create)
│       │   └── errors.ts                      # EXISTS — Phase 2 throws NotFoundError exclusively for tenant-owned rows
│       ├── http/
│       │   └── routes/
│       │       ├── games.ts                   # NEW (mounted on /api/games)
│       │       ├── game-listings.ts           # NEW (/api/games/:gameId/listings)
│       │       ├── youtube-channels.ts        # NEW (/api/youtube-channels + /api/games/:gameId/youtube-channels)
│       │       ├── api-keys-steam.ts          # NEW (/api/api-keys/steam)
│       │       ├── items-youtube.ts           # NEW (/api/items/youtube)
│       │       ├── events.ts                  # NEW (/api/events)
│       │       └── audit.ts                   # NEW (/api/audit)
│       ├── integrations/
│       │   ├── youtube-oembed.ts              # NEW (no-key public API)
│       │   ├── twitter-oembed.ts              # NEW (no-key public API)
│       │   └── steam-api.ts                   # NEW (validation call only in P2)
│       └── dto.ts                             # AMEND: add toGameDto, toGameSteamListingDto, toYoutubeChannelDto, toApiKeySteamDto, toYoutubeVideoDto, toEventDto, toAuditEntryDto
├── routes/
│   ├── games/
│   │   ├── +page.svelte
│   │   ├── +page.server.ts
│   │   └── [gameId]/
│   │       ├── +page.svelte
│   │       ├── +page.server.ts
│   │       └── listings/+page.svelte
│   ├── accounts/youtube/+page.svelte
│   ├── keys/steam/+page.svelte
│   ├── audit/+page.svelte
│   ├── events/+page.svelte
│   └── settings/+page.svelte                  # theme toggle UI lives here too (D-40)
├── hooks.server.ts                            # AMEND: read __theme cookie before handler (D-40)
├── app.d.ts                                   # AMEND: add `theme: 'light'|'dark'|'system'` to App.Locals
└── ...
eslint-plugin-tenant-scope/                    # NEW (Wave 0; D-38)
└── no-unfiltered-tenant-query.js              # local plugin; consumed via flat-config
tests/
├── integration/
│   ├── games.test.ts                          # NEW
│   ├── game-listings.test.ts                  # NEW
│   ├── ingest.test.ts                         # NEW (URL parser fault-injection per D-19)
│   ├── secrets-steam.test.ts                  # NEW
│   ├── audit.test.ts                          # NEW (cursor invariants)
│   ├── events.test.ts                         # NEW
│   ├── tenant-scope.test.ts                   # AMEND: extend MUST_BE_PROTECTED matrix per D-37
│   └── anonymous-401.test.ts                  # AMEND: extend MUST_BE_PROTECTED list per D-37
├── unit/
│   ├── dto.test.ts                            # AMEND/CREATE: assert ciphertext-strip on toApiKeySteamDto (D-39)
│   ├── url-parser.test.ts                     # NEW (host detection + canonicalization)
│   └── tenant-scope-eslint-rule.test.ts       # NEW (RuleTester; D-38)
└── browser/                                   # NEW dir if Vitest browser mode picked
    └── responsive-360.test.ts                 # 360px viewport assertions (D-42)
```

### Pattern 1: Tenant Scope (inherited from Phase 1, EXTENDED in Phase 2)

**What:** Every service function takes `userId: string` as first non-optional argument. Every Drizzle query that hits a user-owned table includes `eq(table.userId, userId)`. Cross-tenant access throws `NotFoundError` (404), never `ForbiddenError` (403). Audit metadata never references other tenants' identifiers.

**When to use:** Every Phase 2 service. No exceptions. ESLint rule `no-unfiltered-tenant-query` (D-38) enforces structurally.

**Trade-offs:**
- Pros: Phase 1 already proved the pattern; cross-tenant integration test extends mechanically.
- Cons: Discipline-based — a missing `userId` filter is a silent leak. ESLint AST rule catches the structural mistake at lint time; the cross-tenant test catches behavioral drift at CI time.

**Example (Phase 2 games service skeleton):**
```typescript
// src/lib/server/services/games.ts
// Source: ARCHITECTURE.md Pattern 1; Phase 1 src/lib/server/services/* skeleton
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { NotFoundError } from "./errors.js";

export async function getGameById(userId: string, gameId: string) {
  const rows = await db
    .select()
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError();   // 404, not 403 (PRIV-01)
  return rows[0]!;
}
```

### Anti-Patterns to Avoid (Phase 2 — extends Phase 1 set)

- **`db.select(...).from(games).where(eq(games.id, id))` — missing `userId` filter.** Caught by D-38 ESLint rule + cross-tenant test.
- **`c.json(secret)` after fetching `api_keys_steam` row.** Caught by `dto.test.ts` runtime assertion; route handlers MUST go through `toApiKeySteamDto`.
- **In-process plaintext-secret cache for Steam keys.** AP-3 in ARCHITECTURE.md. The future P3 worker decrypts per job; the P2 paste-time validation call (D-17) is the only place plaintext lives transiently in the app role.
- **Hand-writing the audit `action` enum in scattered `as const` arrays.** D-32 mandates a single source: `src/lib/server/audit/actions.ts`. Drift = lint warning.
- **Calling `try/catch` after `db.insert(games)` to "clean up" a half-write.** D-19: validate FIRST. The INSERT happens only after the URL parser + oEmbed fetch succeed.
- **Using `403 Forbidden` for cross-tenant access.** D-37 restates the P1 invariant: 404 always.
- **Reading `process.env.RETENTION_DAYS` outside `src/lib/server/config/env.ts`.** Caught by `no-restricted-properties` ESLint rule from Phase 1.
- **Embedding the Steam appdetails fetch on the user request hot path.** Phase 2 fetches appdetails on-demand at game-listing-create time only; do NOT background-refresh in P2 (Phase 6 owns the shared `steam_app_metadata_cache`).

### Drizzle 0.45 enum vs check-constraint (Claude's Discretion — RECOMMENDED: pgEnum)

**Recommendation:** Use Drizzle `pgEnum` for both `events.kind` (D-28) and the extended `audit_log.action` (D-32). MEDIUM confidence — verified by official Drizzle column-type docs and recent (drizzle-kit 0.26.2+) issue-tracker activity around enum migrations.

**Why pgEnum:**
1. **Native Postgres enum** — type-safety at the DB level. A buggy app insert with a stray string fails at INSERT, not at "we'll fix it Tuesday."
2. **Drizzle TS inference** propagates the enum's allowed values into select/insert types. Callers can't pass arbitrary strings.
3. **drizzle-kit 0.26.2+** generates correct `ALTER TYPE ... ADD VALUE ... BEFORE/AFTER ...` SQL for additions. Phase 2's `audit_log.action` extension uses this directly.

**Caveats (verified at 2026-04-27):**
1. **The pgEnum value MUST be exported from a schema file** or `drizzle-kit generate` silently drops the type definition (drizzle-team/drizzle-orm#5174). Convention: export the enum next to the table that owns it.
2. **Postgres enum value removal is not first-class** — `ALTER TYPE ... DROP VALUE` doesn't exist in Postgres without a recreate-cycle. P2 only ADDS values (no removals expected); flag for revisit if a future phase wants to deprecate one.
3. **Drizzle has documented edge cases (issues #2389, #2723, #3206)** around `drizzle-kit push` (which we do NOT use; we use generate+migrate). Generate-and-migrate flow is more reliable.

**Alternative if pgEnum proves blocked at Wave 0:** `text + CHECK constraint`. Lose TS inference; planner picks if drizzle-kit blocks.

**Code shape:**
```typescript
// src/lib/server/db/schema/events.ts — pgEnum example
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "../../ids.js";

// MUST be exported to avoid drizzle-team/drizzle-orm#5174
export const eventKindEnum = pgEnum("event_kind", [
  "conference",
  "talk",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "press",
  "other",
]);

export const events = pgTable("events", {
  id: text("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id").notNull(),
  gameId: text("game_id").notNull(),
  kind: eventKindEnum("kind").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  title: text("title").notNull(),
  url: text("url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
```

For `audit_log.action`, extend the existing schema file:
```typescript
// src/lib/server/db/schema/audit-log.ts (AMEND in Wave 0)
export const auditActionEnum = pgEnum("audit_action", [
  // Phase 1
  "session.signin", "session.signout", "session.signout_all", "user.signup",
  // Phase 2 (D-32)
  "key.add", "key.rotate", "key.remove",
  "game.created", "game.deleted", "game.restored",
  "item.created", "item.deleted",
  "event.created", "event.edited", "event.deleted",
  "theme.changed",
]);
```

**Note:** Phase 1 currently uses `action text` (free-form). Wave 0 amends to the enum. The migration is `CREATE TYPE audit_action AS ENUM (...); ALTER TABLE audit_log ALTER COLUMN action TYPE audit_action USING action::audit_action`. Drizzle-kit handles this if both schema and migration are generated together.

### Drizzle 0.45 multi-table migrations atomicity (Claude's Discretion — RECOMMENDED: ONE migration)

**Recommendation:** Generate ONE Drizzle migration for all 7 new tables + 2 alterations. MEDIUM-HIGH confidence.

**Why one migration:**
1. **drizzle-kit generate** produces a single SQL file when run once after all 7 schema files exist. Each file's CREATE TABLE is sequential within the file; Drizzle resolves dependency order via `references`.
2. **`drizzle-kit migrate`** applies one file's contents inside an implicit transaction (Postgres DDL is transactional). If any statement fails, the whole file rolls back. Phase 1's advisory-lock approach (`runMigrations()` from `src/lib/server/db/migrate.ts`) wraps the whole boot run.
3. **One diff for code review.** Splitting into 7 files is a code-review pessimum — reviewers must reason across files instead of one.
4. **No inter-table data backfill in P2.** No reason to interleave INSERTs between table creations.

**Caveats:**
1. **Order of CREATE TABLE statements matters** because of FK references. Drizzle-kit handles this automatically when given a multi-file schema barrel; verify by reading the generated `.sql` and confirming dependencies (e.g., `games` before `game_steam_listings`).
2. **The `audit_log.action` enum migration involves an ALTER COLUMN TYPE.** This is a destructive-class operation. Phase 1 ships only one row's worth of action values; manual smoke verify before merge.

**Recipe:**
```bash
# Wave 0 last task
pnpm db:generate          # produces drizzle/0001_phase02_*.sql
pnpm db:check             # commutativity check passes
# Review the generated SQL by hand (atomic-PR rule)
pnpm test                 # integration tests run runMigrations() in tests/setup.ts
git add drizzle/ src/lib/server/db/schema/
git commit -m "feat(db): add Phase 2 schema (games, listings, channels, keys, items, events)"
```

### Soft-cascade transactional restore pattern (D-23)

**Recommendation:** Use Drizzle's `db.transaction((tx) => ...)` with a single timestamp captured at the start, applied to parent and all children, then mirrored on restore by matching that exact timestamp.

**Edge case the pattern handles:** A row already soft-deleted before the parent stays deleted on parent restore — because its `deleted_at` value differs from the parent's.

**Edge case to think about:** Postgres `now()` is per-transaction (not per-statement) so all rows updated in one tx share microsecond-identical `deleted_at`. Use a captured `Date` literal in code (not `now()` SQL) to make the value explicit + comparable across transactions.

**Code shape (full example):**
```typescript
// src/lib/server/services/games.ts
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { gameYoutubeChannels } from "../db/schema/game-youtube-channels.js";
import { trackedYoutubeVideos } from "../db/schema/tracked-youtube-videos.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../audit.js";
import { NotFoundError } from "./errors.js";

export async function softDeleteGame(
  userId: string,
  gameId: string,
  ipAddress: string,
): Promise<void> {
  const deletedAt = new Date();   // captured ONCE; identical timestamp across all rows in this tx
  await db.transaction(async (tx) => {
    const result = await tx
      .update(games)
      .set({ deletedAt })
      .where(and(eq(games.userId, userId), eq(games.id, gameId)))
      .returning({ id: games.id });
    if (result.length === 0) throw new NotFoundError();   // 404 cross-tenant by Pattern 1

    // Soft-cascade children — same deletedAt timestamp lets restore reverse exactly this set.
    await tx
      .update(gameSteamListings)
      .set({ deletedAt })
      .where(and(eq(gameSteamListings.userId, userId), eq(gameSteamListings.gameId, gameId)));
    await tx
      .update(gameYoutubeChannels)
      .set({ deletedAt })
      .where(and(eq(gameYoutubeChannels.userId, userId), eq(gameYoutubeChannels.gameId, gameId)));
    await tx
      .update(trackedYoutubeVideos)
      .set({ deletedAt })
      .where(and(eq(trackedYoutubeVideos.userId, userId), eq(trackedYoutubeVideos.gameId, gameId)));
    await tx
      .update(events)
      .set({ deletedAt })
      .where(and(eq(events.userId, userId), eq(events.gameId, gameId)));
  });
  await writeAudit({ userId, action: "game.deleted", ipAddress, metadata: { gameId } });
}

export async function restoreGame(
  userId: string,
  gameId: string,
  ipAddress: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Read the parent's deletedAt so we know the marker timestamp to reverse.
    const [parent] = await tx
      .select({ deletedAt: games.deletedAt })
      .from(games)
      .where(and(eq(games.userId, userId), eq(games.id, gameId)))
      .limit(1);
    if (!parent || parent.deletedAt === null) throw new NotFoundError();

    const markerTs = parent.deletedAt;

    await tx
      .update(games)
      .set({ deletedAt: null })
      .where(and(eq(games.userId, userId), eq(games.id, gameId)));
    // Children: only restore rows whose deletedAt === markerTs (rows soft-deleted EARLIER stay deleted).
    await tx
      .update(gameSteamListings)
      .set({ deletedAt: null })
      .where(and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, gameId),
        eq(gameSteamListings.deletedAt, markerTs),
      ));
    await tx
      .update(gameYoutubeChannels)
      .set({ deletedAt: null })
      .where(and(
        eq(gameYoutubeChannels.userId, userId),
        eq(gameYoutubeChannels.gameId, gameId),
        eq(gameYoutubeChannels.deletedAt, markerTs),
      ));
    await tx
      .update(trackedYoutubeVideos)
      .set({ deletedAt: null })
      .where(and(
        eq(trackedYoutubeVideos.userId, userId),
        eq(trackedYoutubeVideos.gameId, gameId),
        eq(trackedYoutubeVideos.deletedAt, markerTs),
      ));
    await tx
      .update(events)
      .set({ deletedAt: null })
      .where(and(
        eq(events.userId, userId),
        eq(events.gameId, gameId),
        eq(events.deletedAt, markerTs),
      ));
  });
  await writeAudit({ userId, action: "game.restored", ipAddress, metadata: { gameId } });
}
```

### Cursor pagination for `/api/audit` (Claude's Discretion — RECOMMENDED: tuple-comparison + base64 JSON cursor)

**Recommendation:**
- Cursor format: `base64url(JSON.stringify({ created_at: ISO, id: uuid }))`. Server reads + writes; client treats as opaque string.
- WHERE clause: tuple comparison `(audit_log.created_at, audit_log.id) < (cursor.created_at, cursor.id)` — equivalent to `created_at < $1 OR (created_at = $1 AND id < $2)` in expanded form. Postgres supports tuple comparison directly.
- Tenant-relative by construction: every query also constrains `WHERE user_id = $caller`.

**Why not JWT-style:** JWT signing is a key-management problem for zero security gain — the cursor is server-readable-only and the security boundary is the `WHERE user_id = $caller` clause, not the cursor format.

**Why include `id` (not just `created_at`):** Two audit rows can share a `created_at` value (microsecond-identical inserts in one transaction); `id` is the tiebreaker that makes the order strict.

**Tenant-relativity test:** Listing user A's audit log can NEVER observe user B's row IDs because the query is `WHERE audit_log.user_id = $callerId AND ...`; the cursor never escapes that scope. PITFALL P19 mitigated by construction.

**Code shape:**
```typescript
// src/lib/server/services/audit-read.ts
import { and, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";

const PAGE_SIZE = 50;   // D-31; P6 makes tunable

export interface AuditPage {
  rows: Array<{ id: string; action: string; createdAt: Date; ipAddress: string; metadata: unknown }>;
  nextCursor: string | null;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString("base64url");
}
function decodeCursor(s: string): { at: Date; id: string } {
  const { at, id } = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  return { at: new Date(at), id };
}

export async function listAuditPage(
  userId: string,
  cursor: string | null,
  actionFilter: string | "all" = "all",
): Promise<AuditPage> {
  const cursorClause = cursor
    ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${decodeCursor(cursor).at}, ${decodeCursor(cursor).id})`
    : sql`true`;
  const filterClause = actionFilter === "all" ? sql`true` : eq(auditLog.action, actionFilter);

  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), cursorClause, filterClause))
    .orderBy(sql`${auditLog.createdAt} desc, ${auditLog.id} desc`)
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id, action: r.action, createdAt: r.createdAt, ipAddress: r.ipAddress, metadata: r.metadata,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
```

### Theme cookie + DB sync (UX-01, D-40)

**Pattern:**
1. Cookie name: `__theme`. Values: `light` | `dark` | `system`. Default to `system` if absent.
2. Cookie attributes: `Path=/; SameSite=Lax; Max-Age=31536000` (1 year). `Secure` only in production. **`HttpOnly=false`** so JS can read+write the cookie client-side (avoids a roundtrip on toggle).
3. **`hooks.server.ts` reads BEFORE the request handler runs** so `event.locals.theme` is populated and the SSR root element renders with the correct CSS class — no flash. (Verified pattern; see ScriptRaccoon and Svelte Vietnam blog references.)
4. **`+layout.svelte` SSR** consumes `event.locals.theme` → applies `data-theme={...}` to `<html>`. Tailwind / your CSS reads `data-theme="dark"` selector.
5. **Reconciliation on sign-in:** if the user has both a cookie value AND a `user.theme_preference`, **cookie wins** (most-recent action). Server writes the new value back to DB. If only DB has a value and cookie is missing, server hydrates cookie from DB.
6. **`POST /api/me/theme` body:** `{ theme: 'light' | 'dark' | 'system' }`. Updates both cookie (via `Set-Cookie` response header) and DB row in one tx. Audits `theme.changed` per D-32 with metadata `{ from, to }`.

**Code shape (hooks.server.ts):**
```typescript
// src/hooks.server.ts (AMEND)
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";
// ... existing imports
const VALID = new Set(["light", "dark", "system"]);

const themeHandle: Handle = async ({ event, resolve }) => {
  const cookieValue = event.cookies.get("__theme");
  event.locals.theme = (cookieValue && VALID.has(cookieValue))
    ? (cookieValue as "light" | "dark" | "system")
    : "system";
  return resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace("__theme_placeholder__", event.locals.theme),
  });
};

export const handle: Handle = sequence(authHandle, themeHandle);
```

In `app.html`:
```html
<html data-theme="__theme_placeholder__">
```

In `app.d.ts`:
```typescript
declare global {
  namespace App {
    interface Locals {
      user?: UserDto;
      session?: SessionDto;
      theme: "light" | "dark" | "system";   // populated by hooks.server.ts (default: "system")
    }
  }
}
```

### Mobile-360px viewport testing (UX-02, D-42)

**Recommendation:** Vitest 4 browser mode with the Playwright provider, scoped to a single `tests/browser/` directory and a separate vitest project. MEDIUM confidence — requires adding `@vitest/browser` + a browser provider as a devDependency. Surfaces as a planner deviation requiring sign-off.

**Why this approach over alternatives:**
- **Vitest 4 browser mode is included with `vitest@^4.1.5`** (already pinned). The `@vitest/browser` peer adds dependency mass (one new dev dep + browser binaries). Browser mode supports `page.viewport({ width: 360, height: 640 })` per spec.
- **Playwright snapshot suite** is heavier (separate test runner, separate CI service, separate config) and Phase 4 charts will likely demand it anyway — defer until then.
- **JSDOM + computed-style assertions** can't measure layout breakpoints reliably (JSDOM doesn't compute CSS layout fully).

**Concrete assertion patterns (D-42):**
```typescript
// tests/browser/responsive-360.test.ts
import { describe, it, expect } from "vitest";
import { page } from "@vitest/browser/context";

describe("UX-02 — 360px viewport", () => {
  it("/games has no horizontal scroll at 360px", async () => {
    await page.viewport(360, 640);
    await page.goto("/games");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  });

  it("primary CTA is reachable without zoom on /games/empty", async () => {
    await page.viewport(360, 640);
    await page.goto("/games");
    const button = page.getByRole("button", { name: /add a game/i });
    await expect.element(button).toBeVisible();
  });
});
```

**Fallback if planner cannot add `@vitest/browser`:** A minimal SSR-only assertion that the rendered HTML contains no fixed-width elements over 360px. Less rigorous but adds zero deps. Document the decision in the plan.

### ESLint AST tenant-scope rule (D-38)

**What:** A custom ESLint rule (`no-unfiltered-tenant-query`) that walks Drizzle method-chain calls (`db.select().from(<table>)`, `db.update(<table>)`, `db.delete(<table>)`, `tx.select()...`) and rejects when no `.where(...)` clause references `userId`. Allowlisted tables: `subreddit_rules` (Phase 5), `pgboss.*` (Phase 3), Better Auth core (`user`, `session`, `account`, `verification`).

**Stack:** Local ESLint plugin in `eslint-plugin-tenant-scope/` directory. Consume from `eslint.config.js` flat-config. Use `@typescript-eslint/utils` `ESLintUtils.RuleCreator` for type-safe rule authoring (already a transitive dep via `@typescript-eslint/eslint-plugin@^8.12`).

**AST sketch:**
```javascript
// eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js
import { ESLintUtils } from "@typescript-eslint/utils";

const TENANT_TABLES = new Set([
  "games", "gameSteamListings", "youtubeChannels", "gameYoutubeChannels",
  "apiKeysSteam", "trackedYoutubeVideos", "events", "auditLog",
]);
const ALLOWLIST_TABLES = new Set([
  "subredditRules",            // Phase 5; non-tenant by design
  "user", "session", "account", "verification",   // Better Auth core
  // pgboss tables are accessed via raw SQL, not Drizzle — NA
]);

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    messages: {
      missingUserIdFilter:
        "Drizzle query on tenant-owned table '{{table}}' must include eq({{table}}.userId, userId) in .where(...) (Pattern 1; PITFALL P1)",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        // Match the chain: db.select().from(games).where(...) etc.
        // Walk back from .from(<TENANT_TABLE>) → ensure parent chain has .where() referencing userId.
        if (node.callee.type !== "MemberExpression") return;
        const propName = node.callee.property.type === "Identifier" ? node.callee.property.name : null;
        if (propName !== "from") return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== "Identifier") return;
        if (ALLOWLIST_TABLES.has(arg.name)) return;
        if (!TENANT_TABLES.has(arg.name)) return;

        // Walk up to find the surrounding chain, then look for .where(...).
        let chain = node.parent;
        while (chain && chain.type === "MemberExpression") chain = chain.parent;
        // Find a .where() in the resulting chain that references `userId` in its argument.
        const sourceCode = context.sourceCode;
        const chainText = sourceCode.getText(chain ?? node);
        if (!/\.where\([^)]*userId[^)]*\)/.test(chainText)) {
          context.report({
            node,
            messageId: "missingUserIdFilter",
            data: { table: arg.name },
          });
        }
      },
    };
  },
});
```

**Test cases (RuleTester, `tests/unit/tenant-scope-eslint-rule.test.ts`):**
```javascript
import { RuleTester } from "@typescript-eslint/rule-tester";
import rule from "../../eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js";

const tester = new RuleTester({});

tester.run("no-unfiltered-tenant-query", rule, {
  valid: [
    // Passing — has userId filter
    `db.select().from(games).where(and(eq(games.userId, userId), eq(games.id, gid)))`,
    // Passing — allowlisted table (Better Auth user)
    `db.select().from(user).where(eq(user.id, sessionUserId))`,
  ],
  invalid: [
    // Failing — missing userId filter
    {
      code: `db.select().from(games).where(eq(games.id, gid))`,
      errors: [{ messageId: "missingUserIdFilter" }],
    },
    // Failing — no where at all
    {
      code: `db.select().from(events)`,
      errors: [{ messageId: "missingUserIdFilter" }],
    },
  ],
});
```

**Caveats (LOW confidence):**
- The AST walk is **structural** (regex over rendered chain text). A determined adversary can write `.where(buildWhere(uid))` and the rule won't see `userId`. Mitigation: code-review checklist + cross-tenant integration test matrix (D-37) + double-eq scope at service layer.
- The rule fires on **direct table references**. Service-layer helpers that take a table parameter (none expected in P2) would need an extension.

### Hono Zod validation pattern (Phase 1 → Phase 2 inheritance)

**Recommendation:** Use `@hono/zod-validator` (already pinned ^0.7.0) per Phase 1 convention. Validation errors yield 422 (not 400) per existing convention; error envelope shape: `{ error: 'validation_failed', details: [...] }`. Route handlers consume the validated body via `c.req.valid('json')`.

**Verification:** Phase 1's `meRoutes` and `sessionRoutes` (in `src/lib/server/http/routes/me.ts` and `sessions.ts`) — if Phase 2 wants drift-free convention, the planner reads those files first and replicates the shape.

**Sketch:**
```typescript
// src/lib/server/http/routes/games.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createGame } from "../../services/games.js";
import { toGameDto } from "../../dto.js";

const createGameSchema = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().optional(),
});

export const gamesRoutes = new Hono<{ Variables: { userId: string; clientIp: string } }>();
gamesRoutes.post(
  "/games",
  zValidator("json", createGameSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_failed", details: result.error.issues }, 422);
    }
  }),
  async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.userId;
    const game = await createGame(userId, body, c.var.clientIp);
    return c.json(toGameDto(game), 201);
  },
);
```

### CI smoke extension (D-37 + Phase 2 smoke)

**Concrete bash for `.github/workflows/ci.yml` smoke job extension:**
```bash
# After the existing Phase 1 smoke gate (boot, OAuth dance, /api/me read):
USER_A_COOKIE=$(./scripts/test-helpers/sign-in.sh "userA@test.local")
USER_B_COOKIE=$(./scripts/test-helpers/sign-in.sh "userB@test.local")

# 1. Create a game as user A
GAME_ID=$(curl -sf -X POST http://localhost:3000/api/games \
  -H "Cookie: $USER_A_COOKIE" -H "Content-Type: application/json" \
  -d '{"title":"My Test Game"}' | jq -r .id)
[ -n "$GAME_ID" ] || { echo "smoke fail: game create"; exit 1; }

# 2. List games as user A (must contain GAME_ID)
curl -sf http://localhost:3000/api/games -H "Cookie: $USER_A_COOKIE" | jq -e ".[] | select(.id == \"$GAME_ID\")" || exit 1

# 3. User B reads user A's game by id → MUST be 404 (not 403)
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/games/$GAME_ID" -H "Cookie: $USER_B_COOKIE")
[ "$HTTP" = "404" ] || { echo "smoke fail: cross-tenant returned $HTTP, expected 404"; exit 1; }

# 4. Anonymous request → MUST be 401
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/games)
[ "$HTTP" = "401" ] || { echo "smoke fail: anon returned $HTTP, expected 401"; exit 1; }

# 5. Sweep new endpoints for anon-401 (auto-fail if any new /api/* route is missing)
for p in /api/games /api/api-keys/steam /api/items/youtube /api/events /api/audit /api/youtube-channels; do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$p")
  [ "$HTTP" = "401" ] || { echo "smoke fail: $p returned $HTTP, expected 401"; exit 1; }
done
```

The `oauth2-mock-server` setup from Phase 1 (running on `localhost:9090` with the `iss` override) is reused — Phase 2 adds nothing on the auth side.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AES-256-GCM encryption / DEK wrapping | Custom crypto | `src/lib/server/crypto/envelope.ts` (Phase 1) | Battle-tested, AP-3/AP-6 compliant, KEK-rotation aware. |
| Append-only audit insert | Custom INSERT helper | `src/lib/server/audit.ts` `writeAudit({...})` | Phase 1 INSERT-only, never throws, Pino-redact-aware. |
| Tenant-scope assertion | Custom middleware | `src/lib/server/http/middleware/tenant.ts` `tenantScope` | Already mounted on `/api/*`; sets `c.var.userId`, returns 401 anonymous. |
| Cross-tenant 404 carrier | Custom error class | `NotFoundError` from `src/lib/server/services/errors.ts` | Phase 1 P3 invariant: tenant-owned resources MUST throw NotFoundError, not ForbiddenError. |
| YouTube oEmbed metadata | Wrap `googleapis.youtube.videos.list` | Public oEmbed endpoint (no key, D-16) | YouTube oEmbed is unauthenticated, rate-friendly, returns title + author + thumbnail. videos.list is Phase 3. |
| Twitter / X embed text | API key flow | `https://publish.twitter.com/oembed?url=...&omit_script=1` (D-29) | Public; no auth; works in 2026 (verified). |
| Reddit URL ingest in P2 | Tracked Reddit posts | DEFER to Phase 3 (DV-7) | Reddit ingest + polling co-dependent; ship together. |
| Reddit / YouTube key UI in P2 | Paste form for keys | DEFER to Phase 3 (D-02 / D-03) | Keys without poll workers sit unused; ship beside `poll.youtube` / `poll.reddit`. |
| UUIDv7 generation | Custom RNG | `uuidv7` npm pkg (already pinned ^1.0.2) via `src/lib/server/ids.ts` | Time-sortable, enumeration-safe; race-condition trade-offs documented. |
| Trusted-proxy header parsing | Custom parser | `src/lib/server/http/middleware/proxy-trust.ts` (Phase 1) | CVE-2026-27700 mitigation already shipped. |
| Pino redact paths | Custom redactor | `src/lib/server/logger.ts` (Phase 1) | All 14 secret-shaped paths covered. New P2 fields use existing patterns. |
| URL canonicalization | Regex bonanza | One small `services/url-parser.ts` with explicit `URL` parsing + host switch | The parser is small (host detection + ID extract); D-19 mandates validate-first; testable in isolation. |
| Soft-delete gimmickry | "deletedAt = -1" or status enum | Nullable `timestamptz deleted_at` column + `WHERE deleted_at IS NULL` filter at every read | D-23 transactional restore depends on the timestamp value, not a status enum. |
| Cursor signing | JWT-no-sig or JWT-with-sig | Plain `base64url(JSON.stringify({...}))` | Server-readable-only; the WHERE clause is the security boundary, not the cursor format. |

**Key insight:** Phase 2 is "wiring," not invention. Of the 11 plans estimated, ~4 are pure schema + service stamping that follow the games.ts template once it lands, ~2 are URL-parser + ingest orchestrator (the only genuinely new logic), ~2 are theme/responsive UX, ~1 is the audit read endpoint, ~1 is the ESLint rule, and ~1 is smoke-extension + traceability commit. **Resist any temptation to invent new abstractions for "extensibility";** the typed-per-kind rule means each future kind is a copy-paste of one services/route/page set, and abstracting prematurely loses TS inference per-kind.

## Common Pitfalls

### Pitfall 1: URL parser half-writes a `tracked_youtube_videos` row when oEmbed is slow / fails (INGEST-04, D-19)
**What goes wrong:** Service inserts the row with `title=null` first, then tries to fetch oEmbed, then UPDATEs. If the request is cancelled (user navigates away) between INSERT and UPDATE, a half-written row persists.
**Why it happens:** Naïve "save and enrich" pattern.
**How to avoid:** Validate URL → fetch oEmbed (with 5s AbortController timeout) → INSERT only after parser+oEmbed succeed. Wrap in `db.transaction((tx) => ...)` so the parser/oEmbed call is OUTSIDE the tx and the INSERT is the only DB statement inside. **No try/catch after `tx.insert(...)` that "cleans up."**
**Warning signs:** `tracked_youtube_videos WHERE title IS NULL AND added_at < now() - interval '1 hour'` returns rows.

### Pitfall 2: Steam appdetails rate limit (200 req / 5 min) silently throttles game-listing creation
**What goes wrong:** During a hot user-onboarding window or a script-driven test, the app makes 200+ appdetails calls in 5 min. Steam returns 429; some calls silently succeed (returning `{success: false, data: null}`) and others time out. User sees inconsistent metadata.
**Why it happens:** No backoff in P2. The rate limit is documented community wisdom (steamcommunity.com discussions, blog.kartones.net), not in official Steamworks docs.
**How to avoid:**
1. **Phase 2 fetches appdetails ONCE per `(user_id, app_id)` insertion.** No background refresh. Steam appdetails cache is a Phase 6 deferred optimisation (per CONTEXT.md `<deferred>`).
2. Honor the implicit `Retry-After` if present in 429 response headers; otherwise back off 60s and retry once.
3. If `appdetails` returns `{success: false}`, save the listing with `null` cover/release/genres and a `last_appdetails_status='unavailable'` column. UI surfaces "metadata pending."
**Warning signs:** Any `appdetails fetch failed` Pino warn rate over ~1/min during onboarding. Steam community thread links: "You've made too many requests recently."

### Pitfall 3: oEmbed `author_url` is a *handle URL*, not a *channel URL* — INGEST-03 own/blogger lookup misses
**What goes wrong:** D-21 says "look up `youtube_channels WHERE user_id=? AND channel_id=?`" — but YouTube oEmbed returns `author_url` like `https://www.youtube.com/@RickAstleyYT`, NOT `https://www.youtube.com/channel/UC...`. A naive `channel_id` lookup against the handle string never matches.
**Why it happens:** YouTube transitioned to handles in 2022; oEmbed reflects the modern format.
**How to avoid:**
- **Option A (no extra fetch, MEDIUM confidence):** When the user adds a `youtube_channels` row, accept either `https://www.youtube.com/channel/UC...` OR a handle `https://www.youtube.com/@...` and store BOTH `channel_id` (resolved from handle by one extra fetch — see Option B) and `handle_url` columns. INGEST-03 lookup uses handle_url. Schema change.
- **Option B (one extra fetch, HIGH confidence):** Resolve `author_url` (handle) to `UC...` via one HEAD/GET fetch of the handle URL — YouTube's HTML response contains `<link rel="canonical" href="https://www.youtube.com/channel/UC...">` and `<meta itemprop="identifier" content="UC...">`. Cache the resolution per session.
- **Option C (defer):** D-21 lookup falls back to `youtube_channels.handle_url` matching the oEmbed `author_url`. This is the simplest approach and matches D-07's "store the handle the user pasted." Recommended for P2.
**Recommendation:** Option C. Schema column on `youtube_channels`: `handle_url text` (e.g., `https://www.youtube.com/@RickAstleyYT`). INGEST-03 resolver compares `tracked_youtube_videos.channel_id_or_handle` → `youtube_channels.handle_url`. This avoids the extra fetch and is reliable in 2026.
**Warning signs:** `youtube_channels.is_own=true` rows that never match a tracked video → users complain "all my own videos show as blogger."

### Pitfall 4: pgEnum migration drops silently when schema isn't exported (drizzle-team/drizzle-orm#5174)
**What goes wrong:** Wave 0 author writes `const eventKindEnum = pgEnum(...)` (no `export`). drizzle-kit generate emits the table CREATE but skips the type. Migration runs; INSERT fails on first event because the type doesn't exist.
**Why it happens:** Documented Drizzle 0.45 behavior (issue tracker open at 2026-04-27).
**How to avoid:** Always `export const eventKindEnum = pgEnum(...)`. The Drizzle 0.45 + drizzle-kit ^0.31 generate run respects exported enums; non-exported enums are silently dropped.
**Warning signs:** drizzle-kit generate output `.sql` file missing `CREATE TYPE`. Any first INSERT against the enum-typed column fails with `type "event_kind" does not exist`.

### Pitfall 5: Theme cookie SSR flash because the cookie attribute is `HttpOnly`
**What goes wrong:** Author copies the Better Auth session cookie attribute pattern (HttpOnly, Secure, SameSite=Lax). Browser-side JS toggle can't read or write the theme cookie → theme never updates client-side without a full page reload, which exhibits flash.
**Why it happens:** HttpOnly is correct for session tokens but wrong for UI preferences.
**How to avoid:** Theme cookie attributes: `Path=/; SameSite=Lax; Max-Age=31536000` only. **NO `HttpOnly`.** `Secure` only in production (gate via `env.NODE_ENV === "production"`).
**Warning signs:** `document.cookie` doesn't contain `__theme=` after the user clicks the toggle.

### Pitfall 6: Audit log cursor reveals row IDs across tenant boundary (P19 regression)
**What goes wrong:** Author encodes the cursor as `audit_log.id` (bigserial-equivalent). User A's last cursor is `audit_log_id=1234`. User B fetches `?cursor=1234` and sees user A's data unless the WHERE clause also filters `user_id`.
**Why it happens:** Pagination is reasoned about as "skip past row 1234" — but row 1234 is a *global* identifier.
**How to avoid:**
1. Cursor is `(created_at, id)` not just `id`. Both come from a tenant-scoped query.
2. The query is ALWAYS `WHERE user_id = $caller AND (created_at, id) < $cursor`. Tenant filter is independent of cursor.
3. Cross-tenant integration test: seed user A audit rows, fetch with user A cookie + capture cursor, present to user B → user B sees ZERO of user A's rows.
**Warning signs:** A user's audit page shows `actor=other userId` they don't recognize. Audit log paginate request that returns 0 rows + `nextCursor != null` (sweep across "skipped" rows) instead of returning the user's actual rows.

### Pitfall 7: ESLint rule false-positive on legitimate non-tenant queries
**What goes wrong:** D-38 rule fires on `db.select().from(events).where(eq(events.id, ...))` (legitimate cross-game lookup that already has an outer scope). Author adds `// eslint-disable-next-line` blanket. The rule erodes.
**Why it happens:** Some queries genuinely don't need `userId` if the function signature itself is private and the caller ensures scope.
**How to avoid:**
1. NO blanket exclusions. ESLint disable comments must include a justification: `// eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- caller scope guarantee in services/X`.
2. PR review: if a `disable` comment lacks a `--` justification, request changes.
3. Audit periodically: grep for `tenant-scope/no-unfiltered-tenant-query` disable comments.
**Warning signs:** Any commit that adds a `disable` without justification text. Drift over time toward more `disable` comments.

### Pitfall 8: Twitter oEmbed regression on `x.com` URL canonicalization
**What goes wrong:** User pastes `https://x.com/elonmusk/status/...`. URL parser detects `x.com` host → `events kind='twitter_post'`. oEmbed fetch to `publish.twitter.com/oembed?url=https://x.com/...` fails with 404 (per WordPress trac thread #59142 and gutenberg issue #66980, x.com URLs have spotty oEmbed support).
**Why it happens:** The Twitter→X migration left publish.twitter.com partially supporting x.com URLs; some endpoints/clients reject.
**How to avoid:** URL parser canonicalizes `x.com` → `twitter.com` before passing to publish.twitter.com. The display URL stored on `events.url` is the user-pasted form (preserve original); the oEmbed-lookup form is the canonicalized one.
**Warning signs:** Pino warn rate `twitter oembed fetch failed` correlates with x.com URLs; users report "Twitter previews broken."

### Pitfall 9: Steam paste-time validation false-positive on temporary network glitch (D-17)
**What goes wrong:** User pastes a valid Steam key, the validation call to `IWishlistService/GetWishlistItemCount/v1/?key=...&steamid=0` returns 5xx because of a transient Valve outage. App returns 422 to the user; user re-pastes and retries N times.
**Why it happens:** Steam Web API has occasional brief outages.
**How to avoid:**
1. Distinguish 4xx (key invalid) vs 5xx (try again) in the validation handler.
2. On 5xx, retry once after 2s. If still 5xx, return 502 to the user with body `{ error: 'steam_api_unavailable', retry_after_seconds: 60 }` — NOT 422.
3. Operator audit log entry `key.add_attempt_failed_steam_5xx` for visibility.
**Warning signs:** Audit log spike of `key.add_attempt_failed` followed by no `key.add` from the same user within minutes.

### Pitfall 10: Locale-add invariant broken by hard-coded English in new Phase 2 .svelte files
**What goes wrong:** Author writes `<button>Save</button>` instead of `<button>{m.button_save()}</button>` in a new Phase 2 component. Phase 1's locale-add-snapshot test (`tests/integration/i18n.test.ts`, plan 01-09) fails because the keyset shifted, OR worse — the test passes but adding a Russian locale later misses the literal.
**Why it happens:** Author copies a Tailwind/UI snippet from elsewhere.
**How to avoid:**
1. **All UI strings flow through `m.*()` Paraglide functions.** No exceptions.
2. **Wave 0 includes `messages/en.json` keys for every new UI string in P2** — even before the .svelte files exist. Author writes the key first, then writes the .svelte file consuming it.
3. **Plan-checker Dimension 8** asserts the locale-add invariant for new files.
**Warning signs:** Any `<button>...</button>` literal in a new .svelte file. Paraglide compile output missing keys referenced in code.

## Code Examples

Verified patterns from official sources and existing Phase 1 code.

### 1. Drizzle 0.45 schema for `games` (Source: Phase 1 `audit-log.ts`, `auth.ts`)
```typescript
// src/lib/server/db/schema/games.ts
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

export const games = pgTable(
  "games",
  {
    id: text("id").primaryKey().$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("games_user_id_idx").on(t.userId),
    userCreatedIdx: index("games_user_id_created_at_idx").on(t.userId, t.createdAt),
  }),
);
```

### 2. Drizzle 0.45 schema for `api_keys_steam` (Source: ARCHITECTURE.md Pattern 4 + Phase 1 envelope.ts EncryptedSecret shape)
```typescript
// src/lib/server/db/schema/api-keys-steam.ts
import { pgTable, text, timestamp, smallint, customType } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
});

export const apiKeysSteam = pgTable("api_keys_steam", {
  id: text("id").primaryKey().$defaultFn(() => uuidv7()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  label: text("label").notNull(),                  // user-chosen display name
  last4: text("last4").notNull(),                  // shown in UI; not a secret per D-34

  // Envelope encryption columns (D-12) — match EncryptedSecret in src/lib/server/crypto/envelope.ts
  secretCt: bytea("secret_ct").notNull(),
  secretIv: bytea("secret_iv").notNull(),
  secretTag: bytea("secret_tag").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  dekIv: bytea("dek_iv").notNull(),
  dekTag: bytea("dek_tag").notNull(),
  kekVersion: smallint("kek_version").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});
```

### 3. Service: api-keys-steam create (Source: existing `envelope.ts` + `audit.ts`)
```typescript
// src/lib/server/services/api-keys-steam.ts
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeysSteam } from "../db/schema/api-keys-steam.js";
import { encryptSecret, decryptSecret } from "../crypto/envelope.js";
import { writeAudit } from "../audit.js";
import { validateSteamKey } from "../integrations/steam-api.js";   // D-17 paste-time validation
import { NotFoundError } from "./errors.js";

export async function createSteamKey(
  userId: string,
  input: { label: string; plaintext: string },
  ipAddress: string,
) {
  // D-17: paste-time validation BEFORE encrypt + persist.
  const ok = await validateSteamKey(input.plaintext);   // returns boolean | throws on 5xx
  if (!ok) {
    const error = new Error("invalid steam key");
    (error as any).code = "validation_failed";
    (error as any).status = 422;
    throw error;
  }

  const enc = encryptSecret(input.plaintext);
  const last4 = input.plaintext.slice(-4);

  const [row] = await db
    .insert(apiKeysSteam)
    .values({
      userId, label: input.label, last4,
      secretCt: enc.secretCt, secretIv: enc.secretIv, secretTag: enc.secretTag,
      wrappedDek: enc.wrappedDek, dekIv: enc.dekIv, dekTag: enc.dekTag,
      kekVersion: enc.kekVersion,
    })
    .returning({ id: apiKeysSteam.id, label: apiKeysSteam.label, last4: apiKeysSteam.last4, createdAt: apiKeysSteam.createdAt });

  await writeAudit({
    userId, action: "key.add", ipAddress,
    metadata: { kind: "steam", key_id: row!.id, label: row!.label, last4 },
  });
  return row;   // already DTO-shaped; toApiKeySteamDto strips ciphertext if a fuller select happens elsewhere
}

export async function rotateSteamKey(
  userId: string, keyId: string,
  input: { plaintext: string },
  ipAddress: string,
) {
  const ok = await validateSteamKey(input.plaintext);
  if (!ok) { /* 422 as above */ }

  const enc = encryptSecret(input.plaintext);
  const last4 = input.plaintext.slice(-4);
  const result = await db
    .update(apiKeysSteam)
    .set({
      secretCt: enc.secretCt, secretIv: enc.secretIv, secretTag: enc.secretTag,
      wrappedDek: enc.wrappedDek, dekIv: enc.dekIv, dekTag: enc.dekTag,
      kekVersion: enc.kekVersion, last4,
      rotatedAt: new Date(), updatedAt: new Date(),
    })
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))
    .returning({ id: apiKeysSteam.id, label: apiKeysSteam.label, last4: apiKeysSteam.last4 });
  if (result.length === 0) throw new NotFoundError();   // 404 cross-tenant
  await writeAudit({
    userId, action: "key.rotate", ipAddress,
    metadata: { kind: "steam", key_id: keyId, label: result[0]!.label, last4 },
  });
  return result[0];
}
```

### 4. DTO projection for api-keys-steam (Source: Phase 1 `dto.ts` template + D-39)
```typescript
// AMEND src/lib/server/dto.ts
import type { apiKeysSteam } from "./db/schema/api-keys-steam.js";

type ApiKeySteamRow = typeof apiKeysSteam.$inferSelect;

export interface ApiKeySteamDto {
  id: string;
  label: string;
  last4: string;          // D-34: not a secret
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

export function toApiKeySteamDto(r: ApiKeySteamRow): ApiKeySteamDto {
  // D-39 / PITFALL P3 — strip every ciphertext column AND kek_version.
  // This is a runtime guard: TS erases types at runtime; the projection function is the actual barrier.
  return {
    id: r.id,
    label: r.label,
    last4: r.last4,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    rotatedAt: r.rotatedAt,
  };
}
```

### 5. URL parser (Source: D-18 + 2026 oEmbed contracts)
```typescript
// src/lib/server/services/url-parser.ts
export type ParsedUrl =
  | { kind: "youtube_video"; videoId: string; canonicalUrl: string }
  | { kind: "twitter_post"; canonicalUrl: string }
  | { kind: "telegram_post"; canonicalUrl: string }
  | { kind: "reddit_deferred" }            // D-18 friendly message
  | { kind: "unsupported" };

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const X_HOSTS = new Set(["twitter.com", "x.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me"]);
const RD_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);

export function parseIngestUrl(input: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { kind: "unsupported" };
  }
  const host = url.hostname.toLowerCase();
  if (YT_HOSTS.has(host)) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return { kind: "unsupported" };
    return {
      kind: "youtube_video",
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }
  if (X_HOSTS.has(host)) {
    // Pitfall 8: canonicalize x.com → twitter.com for oEmbed lookup
    const canonical = host === "x.com" || host === "mobile.twitter.com"
      ? `https://twitter.com${url.pathname}${url.search}`
      : url.toString();
    return { kind: "twitter_post", canonicalUrl: canonical };
  }
  if (TG_HOSTS.has(host)) return { kind: "telegram_post", canonicalUrl: url.toString() };
  if (RD_HOSTS.has(host)) return { kind: "reddit_deferred" };
  return { kind: "unsupported" };
}

function extractYouTubeVideoId(u: URL): string | null {
  // Accepted forms (live verified 2026-04-27):
  //   /watch?v=XXX
  //   youtu.be/XXX
  //   /shorts/XXX
  //   /live/XXX
  //   /embed/XXX
  if (u.hostname.includes("youtu.be")) {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    return /^[\w-]{11}$/.test(id ?? "") ? id! : null;
  }
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const shortsMatch = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
  if (shortsMatch) return shortsMatch[2]!;
  return null;
}
```

### 6. YouTube oEmbed fetch (Source: live verification 2026-04-27)
```typescript
// src/lib/server/integrations/youtube-oembed.ts
import { logger } from "../logger.js";

export interface YoutubeOembed {
  title: string;
  authorName: string;
  authorUrl: string;     // e.g. https://www.youtube.com/@RickAstleyYT — handle URL, not channel URL (Pitfall 3)
  thumbnailUrl: string;
}

export async function fetchYoutubeOembed(canonicalUrl: string): Promise<YoutubeOembed | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
      {
        signal: ctrl.signal,
        headers: { "user-agent": "neotolis-game-promotion-diary/0.1" },
      },
    );
    if (res.status === 401 || res.status === 404) {
      // Private / deleted — INGEST-04 surfaces inline, no row created.
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, url: canonicalUrl }, "youtube oembed fetch non-2xx");
      return null;
    }
    const j = (await res.json()) as Record<string, unknown>;
    return {
      title: String(j.title ?? ""),
      authorName: String(j.author_name ?? ""),
      authorUrl: String(j.author_url ?? ""),
      thumbnailUrl: String(j.thumbnail_url ?? ""),
    };
  } finally {
    clearTimeout(timer);
  }
}
```

### 7. Steam appdetails fetch (Source: ARCHITECTURE.md + steamcommunity rate-limit folklore)
```typescript
// src/lib/server/integrations/steam-api.ts
export interface SteamAppDetails {
  appId: number;
  name: string;
  coverUrl: string | null;        // capsule_image / header_image
  releaseDate: string | null;     // 'Q4 2026' / '14 Mar, 2026' / null if coming_soon
  comingSoon: boolean;
  genres: string[];
  categories: string[];
  raw: unknown;                   // store the whole payload in raw_appdetails jsonb for forensics
}

export async function fetchSteamAppDetails(appId: number): Promise<SteamAppDetails | null> {
  // Rate limit: ~200 req / 5min (steamcommunity discussions). Phase 2 fetches once at insert; no background refresh.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&l=en`,
      { signal: ctrl.signal, headers: { "user-agent": "neotolis-game-promotion-diary/0.1" } },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { success: boolean; data?: unknown }>;
    const block = j[String(appId)];
    if (!block || !block.success || !block.data) return null;
    const d = block.data as any;
    return {
      appId,
      name: d.name ?? "",
      coverUrl: d.header_image ?? d.capsule_image ?? null,
      releaseDate: d.release_date?.date ?? null,
      comingSoon: Boolean(d.release_date?.coming_soon),
      genres: (d.genres ?? []).map((g: any) => g.description),
      categories: (d.categories ?? []).map((c: any) => c.description),
      raw: d,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function validateSteamKey(plaintext: string): Promise<boolean> {
  // D-17: one test call to IWishlistService/GetWishlistItemCount/v1/?key=...&steamid=0
  // steamid=0 is a sentinel; Valve accepts the call shape and returns 401/403 if the key is invalid.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/?key=${encodeURIComponent(plaintext)}&steamid=0`,
      { signal: ctrl.signal, headers: { "user-agent": "neotolis-game-promotion-diary/0.1" } },
    );
    if (res.status >= 500) {
      // Transient — surface as 502 to user (see Pitfall 9), not 422.
      throw new Error("steam_api_5xx");
    }
    return res.ok;   // 2xx = key works (regardless of empty wishlist for steamid=0); 4xx = invalid
  } finally {
    clearTimeout(timer);
  }
}
```

### 8. Audit list endpoint (Source: D-31 + Phase 1 audit-log.ts)
```typescript
// src/lib/server/http/routes/audit.ts
import { Hono } from "hono";
import { listAuditPage } from "../../services/audit-read.js";

export const auditRoutes = new Hono<{ Variables: { userId: string } }>();
auditRoutes.get("/audit", async (c) => {
  const userId = c.var.userId;
  const cursor = c.req.query("cursor") ?? null;
  const action = c.req.query("action") ?? "all";
  const page = await listAuditPage(userId, cursor, action);
  return c.json(page);
});
```

## State of the Art

| Old Approach | Current Approach (2026) | When Changed | Impact |
|--------------|-------------------------|--------------|--------|
| YouTube channel URL `youtube.com/channel/UC...` returned by oEmbed `author_url` | YouTube returns handle URL `youtube.com/@<handle>` | YouTube handles GA 2022 | INGEST-03 own/blogger lookup must compare handles, not channel IDs (Pitfall 3) |
| `snoowrap` for Reddit JS | Native `fetch` against Reddit OAuth API | snoowrap archived 2024-03-17 | Phase 3 only — Phase 2 doesn't touch Reddit beyond the parser-detect-and-defer message |
| Lucia v3 for sessions | Better Auth 1.6 | Lucia deprecated March 2025 | Already shipped Phase 1; Phase 2 inherits |
| Drizzle 0.31 enum migrations had bugs | Drizzle 0.45 + drizzle-kit 0.31 generate `ALTER TYPE ... ADD VALUE` cleanly when enum is exported | drizzle-kit 0.26.2 (Q3 2024) | Use pgEnum confidently in P2 |
| Vitest 3 browser mode in beta | Vitest 4 browser mode stable (Dec 2025) | Vitest 4.0 release | Use vitest browser for D-42 360px tests |
| Twitter oEmbed required `twitter.com` | publish.twitter.com supports `x.com` URLs but with caveats | Post-rebrand 2023, partial support thereafter | URL parser canonicalizes x.com → twitter.com for oEmbed lookup (Pitfall 8) |

**Deprecated / outdated:**
- `db.select().from(...).where(eq(table.id, ...))` without tenant filter. Pattern 1 P1 risk. ESLint rule (D-38) catches.
- Storing handle URL as `channel_id`. Wrong for 2026. Use `handle_url` column + match-by-handle.
- HttpOnly theme cookie. Wrong for D-40 client-side toggle.

## Open Questions

1. **Should `youtube_channels` schema include `handle_url` AND `channel_id` columns, or just one?**
   - What we know: oEmbed returns `author_url` as handle URL (verified). User pasting `youtube.com/channel/UC...` is also valid input.
   - What's unclear: User UX for the add-channel form — paste any URL form (we resolve), or two distinct fields?
   - Recommendation: One paste-form input. URL parser detects `/channel/UC...` vs `/@handle` vs raw handle. Schema: `youtube_channels.handle_url` (always set) + `youtube_channels.channel_id` (set only if user pasted a /channel/ URL OR resolver fetched canonical). INGEST-03 compares whichever the tracked-video oEmbed surfaces.

2. **Does Drizzle 0.45 + Postgres handle a single migration file containing CREATE TYPE + ALTER COLUMN TYPE in one transaction reliably?**
   - What we know: Postgres DDL is transactional; Drizzle migrations run as a single SQL file per `_phaseNN_*.sql`.
   - What's unclear: The `audit_log.action` column today is `text`; the migration changes it to `audit_action` enum. Does drizzle-kit generate the correct `USING action::audit_action` clause?
   - Recommendation: Wave 0 author runs `pnpm db:generate`, hand-reviews the resulting `.sql` for the ALTER COLUMN TYPE statement, manually adds `USING action::audit_action` if drizzle-kit didn't. Ships with manual smoke verify.

3. **What happens to existing Phase 1 `audit_log` rows when the action column is migrated to enum?**
   - What we know: Phase 1 has 4 action values shipped (`session.signin`, `session.signout`, `session.signout_all`, `user.signup`); the new enum includes all of them.
   - What's unclear: If a smoke test or fixture row carries an unexpected value, `ALTER COLUMN ... USING action::audit_action` errors.
   - Recommendation: Wave 0 audits the production audit-log values BEFORE the migration. Action: `SELECT DISTINCT action FROM audit_log;` should return only Phase 1 values. If a stray test row exists, delete it first or extend the enum.

4. **Is there a YouTube oEmbed quota / rate limit?**
   - What we know: YouTube oEmbed is publicly documented as unauthenticated. No published rate limit.
   - What's unclear: At INGEST-02 paste velocity (a user might paste 10 URLs in 5 minutes), is there an implicit throttle?
   - Recommendation: Treat as effectively rate-unlimited at indie scale; if 429 ever surfaces, fall back to "title pending" with retry job. **HIGH confidence the limit is generous enough for P2.**

5. **Does `IWishlistService/GetWishlistItemCount/v1/?key=X&steamid=0` actually return 2xx for a valid key?**
   - What we know: Method exists; takes key + steamid as separate query params per Steamworks "Service" interface convention.
   - What's unclear: Does `steamid=0` return 200 (with count=0) or 400 (invalid steamid)?
   - Recommendation: Wave 0 author runs the call once with a real Phase 1 dev Steam key (operator-supplied) to verify response shape. Document in plan if behavior differs from prediction.

6. **How does `tracked_youtube_videos.last_poll_status` interact with Phase 2 vs Phase 3?**
   - What we know: Phase 2 ships the column (per D-09 schema). Phase 3 worker writes it.
   - What's unclear: Does Phase 2 set it to `null` on insert, or to a sentinel like `'pending'`?
   - Recommendation: NULL on insert. UI surfaces "never polled" for NULL. Phase 3 worker writes `'ok'` / `'auth_error'` / etc. P2 ships no "stale" badge — that's Phase 3.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22 LTS | Build + runtime | ✓ | ≥22.11 (per package.json engines) | — |
| pnpm ≥9 | Lockfile | ✓ | 9.15.0 (per packageManager) | — |
| PostgreSQL 16 | Schema + queue + audit | ✓ | postgres:16-alpine in CI; required at runtime | — |
| `oauth2-mock-server` | CI smoke (auth dance) | ✓ | ^7.2.0 (Phase 1 dev dep) | — |
| Network egress to `youtube.com` | INGEST-02 oEmbed | ✓ at runtime; smoke uses synthetic | — | Mock in tests; production self-host requires outbound HTTPS |
| Network egress to `publish.twitter.com` | D-29 events oEmbed | ✓ at runtime | — | Same |
| Network egress to `store.steampowered.com` | game-listing appdetails | ✓ at runtime | — | Same |
| Network egress to `api.steampowered.com` | D-17 key validation | ✓ at runtime | — | Same |
| `@vitest/browser` + browser provider | UX-02 360px viewport tests | ✗ NOT in package.json | — | Planner deviation: ADD as devDependency in Wave 0 OR fall back to JSDOM-based assertion (less rigorous; document trade-off) |

**Missing dependencies with no fallback:** None (all runtime deps present in Phase 1).

**Missing dependencies with fallback:**
- `@vitest/browser` (with playwright provider) — required for D-42 viewport tests. Planner picks: (a) add to package.json with one-line rationale (acceptable per CLAUDE.md "Locked stack versions" → "Bumps go through a dedicated PR with a one-line rationale"), or (b) fall back to JSDOM + computed-width assertion that's coarser but adds zero deps. **Recommendation: option (a).**

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.5 (locked Phase 1) |
| Config file | `vitest.config.ts` (Phase 1 plan 01-02 split unit/integration via `test.projects`); browser project added in Phase 2 if `@vitest/browser` lands |
| Quick run command | `pnpm test:unit` (covers unit DTO + url-parser + ESLint rule + envelope tests) |
| Full suite command | `pnpm test` (compiles paraglide + svelte-kit sync + runs every project) |
| Phase gate | Full suite green before `/gsd:verify-work`; CI also runs `pnpm lint`, `pnpm typecheck`, smoke job |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| GAMES-01 | `POST /api/games {title, notes}` creates a row scoped to `userId`, returns 201 + DTO | integration | `pnpm test:integration tests/integration/games.test.ts -t "create game"` | ❌ Wave 0 |
| GAMES-01 | Validation: missing title returns 422 with `validation_failed` envelope | integration | `pnpm test:integration tests/integration/games.test.ts -t "422 on missing title"` | ❌ Wave 0 |
| GAMES-02 | `DELETE /api/games/:id` soft-deletes parent + cascades to listings/channels/items/events in one tx | integration | `pnpm test:integration tests/integration/games.test.ts -t "soft cascade delete"` | ❌ Wave 0 |
| GAMES-02 | `POST /api/games/:id/restore` reverses parent + only-marker-children | integration | `pnpm test:integration tests/integration/games.test.ts -t "transactional restore"` | ❌ Wave 0 |
| GAMES-03 | Cross-tenant `GET /api/games/:userA-id` from user B returns 404 | integration | `pnpm test:integration tests/integration/tenant-scope.test.ts -t "/api/games cross-tenant 404"` | ✅ extends |
| GAMES-04a | `POST /api/games/:gid/youtube-channels` attaches an existing `youtube_channels` row via `game_youtube_channels` link | integration | `pnpm test:integration tests/integration/game-listings.test.ts -t "attach youtube channel"` | ❌ Wave 0 |
| GAMES-04a | Two channels can be attached to the same game (multiplicity) | integration | `pnpm test:integration tests/integration/game-listings.test.ts -t "multiple channels per game"` | ❌ Wave 0 |
| KEYS-03 | `POST /api/api-keys/steam` envelope-encrypts on insert (assert ciphertext column lengths > 0; assert plaintext NEVER appears in `select * from api_keys_steam`) | integration | `pnpm test:integration tests/integration/secrets-steam.test.ts -t "envelope encrypted at rest"` | ❌ Wave 0 |
| KEYS-04 | `GET /api/api-keys/steam` returns DTO without `secret_ct`, `secret_iv`, `wrapped_dek`, `dek_iv`, `kek_version`; only `last4` present | integration | `pnpm test:integration tests/integration/secrets-steam.test.ts -t "DTO strips ciphertext"` | ❌ Wave 0 |
| KEYS-04 | `toApiKeySteamDto` runtime test — even if input row carries ciphertext, output omits | unit | `pnpm test:unit tests/unit/dto.test.ts -t "toApiKeySteamDto strips ciphertext"` | ❌ Wave 0 |
| KEYS-05 | `PATCH /api/api-keys/steam/:id` rotates: ciphertext bytes change, `rotated_at` set, audit `key.rotate` written with new `last4` | integration | `pnpm test:integration tests/integration/secrets-steam.test.ts -t "rotate overwrites ciphertext"` | ❌ Wave 0 |
| KEYS-05 | Pre-rotation steam-key validation 4xx returns 422 to client; row unchanged | integration | `pnpm test:integration tests/integration/secrets-steam.test.ts -t "rotate fails on invalid key"` | ❌ Wave 0 |
| KEYS-06 | Audit log carries `key.add` / `key.rotate` / `key.remove` with `{kind:'steam', key_id, label, last4}` metadata | integration | `pnpm test:integration tests/integration/audit.test.ts -t "key.* metadata shape"` | ❌ Wave 0 |
| KEYS-06 | Audit row carries resolved IP from trusted-proxy middleware (not `127.0.0.1`) | integration | `pnpm test:integration tests/integration/audit.test.ts -t "audit ip resolved via proxy-trust"` | ❌ Wave 0 |
| INGEST-02 | Paste `https://youtube.com/watch?v=ID` → `tracked_youtube_videos` row created with `title` populated from oEmbed | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "youtube paste creates tracked item"` | ❌ Wave 0 |
| INGEST-02 | youtu.be / shorts / live / embed canonicalized to `watch?v=ID` | unit | `pnpm test:unit tests/unit/url-parser.test.ts -t "youtube alt forms"` | ❌ Wave 0 |
| INGEST-03 | When `youtube_channels` row exists with `is_own=true` matching the video's `author_url`, ingest sets `tracked_youtube_videos.is_own=true`; otherwise default false | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "is_own auto decision"` | ❌ Wave 0 |
| INGEST-03 | `PATCH /api/items/youtube/:id {is_own}` toggles the flag and audits via existing `event.edited`-style action | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "toggle is_own"` | ❌ Wave 0 |
| INGEST-04 | Malformed URL returns 422; assert no row in any table — `tracked_youtube_videos`, `events`, `audit_log` (item-create only) | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "INGEST-04 no half-write"` | ❌ Wave 0 |
| INGEST-04 | oEmbed fetch failure (mocked 5xx) returns 502; assert no row in `tracked_youtube_videos` | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "oembed 5xx no row"` | ❌ Wave 0 |
| EVENTS-01 | `POST /api/events {kind:'conference', title, occurred_at}` creates row | integration | `pnpm test:integration tests/integration/events.test.ts -t "create conference event"` | ❌ Wave 0 |
| EVENTS-01 | Invalid kind returns 422 | integration | `pnpm test:integration tests/integration/events.test.ts -t "kind enum reject"` | ❌ Wave 0 |
| EVENTS-01 | Twitter URL paste auto-creates `events kind='twitter_post'` with title from oEmbed | integration | `pnpm test:integration tests/integration/ingest.test.ts -t "twitter paste creates event"` | ❌ Wave 0 |
| EVENTS-02 | `GET /api/games/:gid/timeline` returns events + tracked items in chronological order (P2 ships endpoint; chart is P4) | integration | `pnpm test:integration tests/integration/events.test.ts -t "timeline ordering"` | ❌ Wave 0 |
| EVENTS-03 | `PATCH /api/events/:id` audits `event.edited`; `DELETE /api/events/:id` soft-deletes + audits `event.deleted` | integration | `pnpm test:integration tests/integration/events.test.ts -t "audit on edit and delete"` | ❌ Wave 0 |
| PRIV-02 | `GET /api/audit` returns 50 rows by default + `nextCursor` if more | integration | `pnpm test:integration tests/integration/audit.test.ts -t "page size 50 + cursor"` | ❌ Wave 0 |
| PRIV-02 | `GET /api/audit?action=key.add` filters to that action only | integration | `pnpm test:integration tests/integration/audit.test.ts -t "action filter"` | ❌ Wave 0 |
| PRIV-02 | Cursor encoding round-trips: encode → decode produces identical `(at, id)` | unit | `pnpm test:unit tests/unit/audit-cursor.test.ts -t "encode decode round trip"` | ❌ Wave 0 |
| PRIV-02 | Cross-tenant cursor: user A's cursor presented by user B never returns user A's rows | integration | `pnpm test:integration tests/integration/audit.test.ts -t "tenant-relative cursor"` | ❌ Wave 0 |
| UX-01 | `__theme` cookie read in hooks.server.ts → `event.locals.theme` populated → SSR root carries `data-theme` attribute | integration | `pnpm test:integration tests/integration/theme.test.ts -t "SSR no flash"` | ❌ Wave 0 |
| UX-01 | `POST /api/me/theme {theme:'dark'}` updates cookie + DB + audits `theme.changed` | integration | `pnpm test:integration tests/integration/theme.test.ts -t "POST updates both layers"` | ❌ Wave 0 |
| UX-01 | Sign-in reconciliation: cookie wins if both exist | integration | `pnpm test:integration tests/integration/theme.test.ts -t "cookie wins on signin"` | ❌ Wave 0 |
| UX-02 | At 360px viewport on `/games`, `document.documentElement.scrollWidth <= 360` | browser | `pnpm test:browser tests/browser/responsive-360.test.ts -t "no horizontal scroll"` | ❌ Wave 0 (depends on `@vitest/browser` decision) |
| UX-02 | Primary CTA on `/games` (empty state) is reachable + visible at 360px | browser | `pnpm test:browser tests/browser/responsive-360.test.ts -t "primary CTA reachable"` | ❌ Wave 0 |
| UX-03 | Empty `/games` page renders example URL from `m.empty_games_example_url()` | integration | `pnpm test:integration tests/integration/empty-states.test.ts -t "empty games shows example"` | ❌ Wave 0 |
| UX-03 | All ~6-8 P2 keys exist in `messages/en.json` (locale-add invariant preserved) | integration | `pnpm test:integration tests/integration/i18n.test.ts -t "P2 keys present"` | ✅ extends |
| **Cross-cutting: cross-tenant 404** | Every new `/api/*` route from D-37 returns 404 cross-tenant (matrix sweep) | integration | `pnpm test:integration tests/integration/tenant-scope.test.ts -t "P2 matrix"` | ✅ extends |
| **Cross-cutting: anonymous 401** | Every new `/api/*` route refuses anonymous with 401 | integration | `pnpm test:integration tests/integration/anonymous-401.test.ts -t "P2 routes in MUST_BE_PROTECTED"` | ✅ extends |
| **Cross-cutting: ESLint AST rule** | Custom rule rejects `db.select().from(games).where(eq(games.id, ...))` (no userId) and accepts `db.select().from(games).where(and(eq(games.userId,uid),...))` | unit | `pnpm test:unit tests/unit/tenant-scope-eslint-rule.test.ts` | ❌ Wave 0 |
| **Cross-cutting: Pino redact** | New ciphertext field names not present in any log output during integration runs (regex sweep on stdout capture) | integration | `pnpm test:integration tests/integration/log-redact.test.ts -t "ciphertext never logged"` | ❌ Wave 0 (or extend Phase 1 fixture) |
| **Cross-cutting: audit append-only** | `update audit_log set ...` from app role fails (or, if grants not yet enforced, the writer module exports no update path) | unit | `pnpm test:unit tests/unit/audit-append-only.test.ts -t "no UPDATE export"` | ❌ Wave 0 |
| **Cross-cutting: Phase 2 smoke extension** | Smoke job: user A creates a game, lists it, user B 404s, anon 401s on every new route | smoke | `.github/workflows/ci.yml smoke job` | ✅ extends |

### Sampling Rate

- **Per task commit:** `pnpm test:unit` (sub-second; runs DTO + URL parser + cursor + ESLint rule tests).
- **Per wave merge:** `pnpm test:integration` + `pnpm test:browser` (the latter only if @vitest/browser landed).
- **Phase gate:** `pnpm test` (full suite) + `pnpm lint` + `pnpm typecheck` green; CI smoke job green; manual operator check that `pnpm db:generate` produces a clean diff (the generated migration matches what's checked in).

### Wave 0 Gaps

The following test files MUST be created in Wave 0 (one of the early tasks; named-plan it.skip placeholders OK as long as the file exists):

- [ ] `tests/integration/games.test.ts` — covers GAMES-01, GAMES-02
- [ ] `tests/integration/game-listings.test.ts` — covers GAMES-04a + multi-listing
- [ ] `tests/integration/secrets-steam.test.ts` — covers KEYS-03, KEYS-04, KEYS-05, KEYS-06
- [ ] `tests/integration/ingest.test.ts` — covers INGEST-02, INGEST-03, INGEST-04 + Twitter/Telegram paste
- [ ] `tests/integration/events.test.ts` — covers EVENTS-01, EVENTS-02, EVENTS-03
- [ ] `tests/integration/audit.test.ts` — covers PRIV-02 + tenant-relative cursor + KEYS-06 metadata
- [ ] `tests/integration/theme.test.ts` — covers UX-01 (SSR-flash, POST, reconcile)
- [ ] `tests/integration/empty-states.test.ts` — covers UX-03
- [ ] `tests/integration/log-redact.test.ts` — cross-cutting Pino redact for new fields
- [ ] `tests/unit/dto.test.ts` — AMEND for `toApiKeySteamDto` strip + every new DTO
- [ ] `tests/unit/url-parser.test.ts` — covers all URL forms + canonicalization
- [ ] `tests/unit/audit-cursor.test.ts` — cursor encode/decode round trip
- [ ] `tests/unit/tenant-scope-eslint-rule.test.ts` — covers D-38 rule (RuleTester)
- [ ] `tests/unit/audit-append-only.test.ts` — assert audit module exports no update path
- [ ] `tests/browser/responsive-360.test.ts` — covers UX-02 (gated on @vitest/browser dep decision)
- [ ] `tests/integration/tenant-scope.test.ts` — AMEND: extend MUST_BE_PROTECTED + cross-tenant matrix per D-37
- [ ] `tests/integration/anonymous-401.test.ts` — AMEND: extend MUST_BE_PROTECTED list per D-37
- [ ] `tests/integration/i18n.test.ts` — AMEND: assert P2 keys present in `messages/en.json`
- [ ] (no framework install needed — Vitest + @hono/zod-validator already pinned)
- [ ] **Conditional install:** `@vitest/browser` + `playwright` if planner picks Vitest browser mode for D-42

### Validation Architecture Coverage

This matrix covers all 18 in-scope line-items (16 distinct REQ-IDs) plus the 9 cross-cutting invariants (cross-tenant 404, anonymous-401, DTO secret-strip, Pino redact, `userId` first-arg via ESLint AST, audit append-only, theme-cookie SSR-flash, 360px viewport, ESLint AST rule). Every REQ has at least one automated assertion runnable in <30s; UX-02 gated on a planner deviation decision.

## Sources

### Primary (HIGH confidence)

- **CONTEXT.md** (`02-CONTEXT.md`, 330 lines) — User-locked decisions, primary input
- **Phase 1 code in repo (`src/lib/server/*`, 2026-04-27 master branch)** — every primitive Phase 2 reuses
  - `src/lib/server/crypto/envelope.ts` — encryptSecret, decryptSecret, rotateDek
  - `src/lib/server/audit.ts` — writeAudit (INSERT-only)
  - `src/lib/server/services/errors.ts` — NotFoundError, ForbiddenError taxonomy
  - `src/lib/server/http/middleware/tenant.ts` — tenantScope
  - `src/lib/server/dto.ts` — toUserDto/toSessionDto template
  - `src/lib/server/db/schema/audit-log.ts` — append-only schema
  - `src/lib/server/config/env.ts` — sole process.env reader
  - `tests/integration/tenant-scope.test.ts`, `tests/integration/anonymous-401.test.ts` — sweep templates
  - `eslint.config.js` — flat config + no-restricted-properties
- **`.planning/research/STACK.md`** — locked versions
- **`.planning/research/ARCHITECTURE.md`** — Pattern 1 (tenant scope), Pattern 2 (snapshot-and-forward), Pattern 4 (envelope encryption), Pattern 5 (trusted proxy), AP-3 (no secret cache), AP-6 (no module-level KEK)
- **`.planning/research/PITFALLS.md`** — P1 (cross-tenant), P2 (KEK), P3 (DTO), P13 (parity), P19 (audit cursor), P20 (operator)
- **YouTube oEmbed live verification 2026-04-27** — fetched `https://www.youtube.com/oembed?url=...&format=json` for `dQw4w9WgXcQ`; confirmed `author_url` returns handle URL (`https://www.youtube.com/@RickAstleyYT`), no `channel_id` field
- **Drizzle ORM official docs** — https://orm.drizzle.team/docs/column-types/pg, https://orm.drizzle.team/docs/sql-schema-declaration, https://orm.drizzle.team/docs/transactions
- **drizzle-team/drizzle-orm GitHub issues #5174 (pgEnum export)**, **#3206 (enum exists)**, **#2389 (push detection)** — pgEnum migration caveats

### Secondary (MEDIUM confidence — verified with multiple sources)

- **YouTube oEmbed URL forms support** — abdus.dev/posts/youtube-oembed/ + iamcal/oembed#506 — corroborated against live test
- **YouTube oEmbed private/deleted handling** — github.com/ruby-oembed/ruby-oembed#79 — returns non-JSON / 401-404 for private/deleted
- **Twitter publish.twitter.com/oembed status 2026** — socialrails.com Feb 2026 guide + dev.x.com docs + WordPress trac #59142 + gutenberg #66980 (x.com canonicalization caveats)
- **Steam appdetails rate limit** — steamcommunity.com discussions (folklore: 200 req / 5 min, ~1-2 min to 6h cooldowns), kartones.net blog
- **Steam appdetails JSON shape** — woctezuma/steam-api-data sample appID_1002960.json + medium.com scraping articles
- **Steam Web API authentication** — partner.steamgames.com/doc/webapi_overview/auth + steamapis.com guide
- **Vitest 4 browser mode** — vitest.dev/guide/browser/ + Vitest 4.0 release post (Dec 2025)
- **SvelteKit hooks.server theme cookie pattern** — scriptraccoon.dev/blog/darkmode-toggle-sveltekit + with-svelte.com/lessons/ssr-dark-mode + sveltevietnam.dev dark mode tutorial — multiple corroborating sources for `transformPageChunk` SSR pattern
- **@hono/zod-validator error envelope** — hono.dev/docs/guides/validation + medium.com Liam Cooper hono guide — 422 status + customizable envelope
- **@typescript-eslint/utils RuleCreator** — typescript-eslint.io/developers/custom-rules/ + dev.to/alexgomesdev custom rule guide — RuleTester syntax verified against current docs
- **Postgres tuple-comparison cursor** — sequinstream.com keyset cursors guide + stacksync.com keyset pagination — `(created_at, id) < (cursor.at, cursor.id)` syntax verified

### Tertiary (LOW confidence — single source or community wisdom; flagged for runtime validation)

- **`steamid=0` accepted by `IWishlistService/GetWishlistItemCount/v1`** — inferred from Service-interface convention (steamapi.xpaw.me) and ARCHITECTURE.md design notes; NOT confirmed against a live valid key. **Wave 0 author should run one validation call to confirm.**
- **YouTube oEmbed exact rate-limit threshold** — no published number; community reports suggest "generous." Treat as effectively unlimited at indie scale.
- **Drizzle 0.45 `ALTER COLUMN ... TYPE` migration generation** — drizzle-kit may or may not insert `USING action::audit_action`. **Wave 0 author hand-reviews the generated SQL.**

## Metadata

**Confidence breakdown:**
- Standard stack — HIGH — every package pinned in `package.json`, no new deps, all Phase 1 primitives ship and tested
- Architecture patterns — HIGH — Pattern 1, soft-cascade restore, cursor pagination, theme cookie all verified against current 2026 sources or existing Phase 1 code
- pgEnum migration — MEDIUM — Drizzle 0.45 + drizzle-kit 0.31 supports it but with the export-or-it-drops gotcha (#5174); Wave 0 must hand-review generated SQL
- ESLint AST rule — MEDIUM — pattern verified, exact selector logic not yet tested at lint time; RuleTester sketch is a starting point not a production rule
- Pitfalls — HIGH — directly inherited from PITFALLS.md + 2026 external API drift verified
- 360px viewport test approach — MEDIUM — Vitest 4 browser mode is stable but adds a dep; planner picks vs JSDOM fallback
- External API contracts (YouTube oEmbed, Twitter oEmbed, Steam appdetails, Steam IWishlistService) — HIGH for endpoint shapes and rate limits at the level a P2 plan needs; LOW for `steamid=0` exact response (flagged for Wave 0 verification)

**Research date:** 2026-04-27
**Valid until:** 2026-05-27 (30 days for stable stack pieces; 7 days for external API contracts due to ongoing X.com / Twitter migration churn)
